import mongoose from 'mongoose';
import { Payment, PaymentOrder, Refund, PaymentEvent, Customer, PAYMENT_STATUS_RANK } from '../../models/index.js';
import * as client from './razorpay.client.js';
import { requireCredentials, getRawCredentials } from '../integration.credentials.js';
import { getSection } from '../settings.service.js';
import { findOrCreateCustomer, touchCustomer, displayName } from '../customer.service.js';
import { emitEvent } from '../event.bus.js';
import { emitToPermission } from '../socket.js';
import { hmacSha256Hex, safeEqual } from '../../utils/crypto.js';
import { redactDeep } from '../../utils/redact.js';
import { getPagination, pageMeta } from '../../utils/pagination.js';
import { escapeRegex } from '../../utils/phone.js';
import { ApiError } from '../../utils/ApiError.js';

const actorOf = (u) => u && { userId: u.id, name: u.name, role: u.role };
const rank = (s) => PAYMENT_STATUS_RANK[s] ?? -1;
const fromEpoch = (s) => (s ? new Date(Number(s) * 1000) : undefined);
const isObjectId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v) && /^[a-f\d]{24}$/i.test(v);

/* ------------------------------ mapping ------------------------------ */

/** Razorpay payment.status → local status (refund state derived from amount_refunded). */
export function mapPaymentStatus(entity) {
  const refunded = Number(entity.amount_refunded || 0);
  if (entity.status === 'refunded' || (refunded > 0 && refunded >= entity.amount)) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  switch (entity.status) {
    case 'captured': return 'captured';
    case 'authorized': return 'authorized';
    case 'failed': return 'failed';
    default: return 'created';
  }
}

function methodDetails(e) {
  return {
    vpa: e.vpa || undefined,
    bank: e.bank || undefined,
    wallet: e.wallet || undefined,
    cardLast4: e.card?.last4 || undefined,
    cardNetwork: e.card?.network || undefined,
  };
}

async function resolveCustomerId(entity, existing) {
  if (existing?.customerId) return existing.customerId;
  const order = entity.order_id ? await PaymentOrder.findOne({ orderId: entity.order_id }).select('customerId').lean() : null;
  if (order?.customerId) return order.customerId;
  const noteId = entity.notes?.customerId;
  if (isObjectId(noteId) && (await Customer.exists({ _id: noteId }))) return noteId;
  if (entity.contact || entity.email) {
    const { customer } = await findOrCreateCustomer({ phone: entity.contact, email: entity.email, name: entity.notes?.name, source: 'Payment' });
    if (customer) return customer._id;
  }
  return undefined;
}

async function recordEvent({ eventId, type, paymentId, orderId, refundId, payload }) {
  const filter = eventId ? { eventId, type, paymentId: paymentId || null } : { type, paymentId: paymentId || null, refundId: refundId || null, orderId: orderId || null, createdAt: { $gte: new Date(Date.now() - 1000) } };
  await PaymentEvent.updateOne(filter, { $setOnInsert: { eventId, type, paymentId, orderId, refundId, payload: redactDeep(payload) } }, { upsert: true }).catch(() => {});
}

/* ------------------------------ upsert core ------------------------------ */

/**
 * Idempotent payment upsert. Safe against duplicate deliveries, out-of-order webhooks and concurrent writers:
 *  - the row is created with an atomic upsert ($setOnInsert),
 *  - later changes only apply when they advance the status rank, using the previous status as a compare-and-set guard,
 *  - domain events fire only on the transition INTO captured / failed, so a replay never re-notifies.
 * Returns { payment, transition: {from, to}, created }.
 */
export async function applyPaymentEntity(entity, { verifiedByClient = false } = {}) {
  if (!entity?.id) throw new Error('Payment entity has no id');
  const status = mapPaymentStatus(entity);
  const refunded = Number(entity.amount_refunded || 0);
  const fields = {
    orderId: entity.order_id || undefined,
    amount: Number(entity.amount),
    currency: entity.currency || 'INR',
    method: entity.method || undefined,
    methodDetails: methodDetails(entity),
    email: entity.email ? String(entity.email).toLowerCase() : undefined,
    contact: entity.contact || undefined,
    description: entity.description || undefined,
    notes: redactDeep(Array.isArray(entity.notes) ? {} : entity.notes || {}),
    fee: entity.fee ?? undefined,
    tax: entity.tax ?? undefined,
    errorCode: entity.error_code || undefined,
    errorDescription: entity.error_description || undefined,
    razorpayCreatedAt: fromEpoch(entity.created_at) || new Date(),
    lastEventAt: new Date(),
  };
  if (Number.isNaN(fields.amount)) throw new Error('Payment entity has an invalid amount');

  let insertedNow = false;
  let before = null;
  try {
    before = await Payment.findOneAndUpdate(
      { paymentId: entity.id },
      { $setOnInsert: { paymentId: entity.id, ...fields, status, amountRefunded: refunded, ...(status === 'captured' ? { capturedAt: new Date() } : {}), ...(status === 'failed' ? { failedAt: new Date() } : {}), verifiedByClient } },
      { upsert: true, new: false }
    );
    insertedNow = before === null;
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  let from = insertedNow ? null : before?.status;
  let payment = null;

  if (!insertedNow) {
    // Compare-and-set loop: retry a couple of times if another writer moved the status meanwhile.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = attempt === 0 && before ? before : await Payment.findOne({ paymentId: entity.id });
      if (!current) break;
      from = current.status;
      const advance = rank(status) > rank(current.status);
      const set = { lastEventAt: new Date() };
      // Non-status details may fill gaps; never overwrite a good value with an empty one.
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'lastEventAt' || v === undefined) continue;
        if (k === 'notes' && current.notes && Object.keys(current.notes).length) continue;
        set[k] = v;
      }
      if (verifiedByClient) set.verifiedByClient = true;
      if (advance) {
        set.status = status;
        if (status === 'captured') set.capturedAt = current.capturedAt || new Date();
        if (status === 'failed') set.failedAt = current.failedAt || new Date();
      }
      if (refunded > (current.amountRefunded || 0)) set.amountRefunded = refunded;
      // A failed payment's error details must not overwrite a captured one.
      if (!advance && rank(current.status) > rank('failed')) { delete set.errorCode; delete set.errorDescription; }
      const won = await Payment.findOneAndUpdate({ paymentId: entity.id, status: current.status }, { $set: set }, { new: true });
      if (won) { payment = won; break; }
    }
    if (!payment) payment = await Payment.findOne({ paymentId: entity.id });
  } else {
    payment = await Payment.findOne({ paymentId: entity.id });
  }

  const to = payment.status;
  // True only on the transition INTO `target`, so replays and duplicates never re-notify.
  const into = (target) => to === target && (from === null || (from !== target && rank(from) < rank(target)));

  // Attach customer (post-insert so a failure here never loses the payment).
  if (!payment.customerId) {
    const customerId = await resolveCustomerId(entity, null);
    if (customerId) {
      payment = await Payment.findOneAndUpdate({ paymentId: entity.id, customerId: { $exists: false } }, { $set: { customerId } }, { new: true }) || (await Payment.findOne({ paymentId: entity.id }));
    }
  }

  const customer = payment.customerId ? await Customer.findById(payment.customerId) : null;
  const name = customer ? displayName(customer) : payment.email || (payment.contact ? `+${String(payment.contact).replace(/^\+/, '')}` : 'Unknown customer');
  const data = { customer: name, amount: payment.amount, currency: payment.currency, orderId: payment.orderId, paymentId: payment.paymentId, method: payment.method?.toUpperCase() };

  if (into('captured')) {
    if (payment.orderId) {
      await PaymentOrder.updateOne({ orderId: payment.orderId }, { $set: { status: 'paid', paidAt: payment.capturedAt, paymentId: payment.paymentId, amountPaid: payment.amount } });
    }
    await touchCustomer(payment.customerId);
    await emitEvent('PAYMENT_SUCCESS', {
      customerId: payment.customerId, actorType: 'webhook', source: 'payment', description: `Payment ${payment.paymentId} of ${formatInr(payment)} received from ${name}`,
      metadata: { paymentId: payment.paymentId, orderId: payment.orderId, amount: payment.amount, method: payment.method }, data,
    });
    const { largePaymentThreshold } = await getSection('payments');
    if (payment.amount >= Math.round(Number(largePaymentThreshold) * 100)) {
      await emitEvent('PAYMENT_LARGE', { customerId: payment.customerId, actorType: 'webhook', source: 'payment', description: `Large payment of ${formatInr(payment)} from ${name}`, data });
    }
    emitToPermission('payments:read', 'payment:new', publicPayment(payment));
  } else if (into('failed')) {
    await emitEvent('PAYMENT_FAILED', {
      customerId: payment.customerId, actorType: 'webhook', source: 'payment', description: `Payment ${payment.paymentId} of ${formatInr(payment)} failed${payment.errorDescription ? `: ${payment.errorDescription}` : ''}`,
      metadata: { paymentId: payment.paymentId, orderId: payment.orderId, errorCode: payment.errorCode }, data: { ...data, reason: payment.errorDescription || payment.errorCode },
    });
    emitToPermission('payments:read', 'payment:update', publicPayment(payment));
  } else if (from !== to || insertedNow) {
    emitToPermission('payments:read', 'payment:update', publicPayment(payment));
  }
  return { payment, created: insertedNow, transition: { from, to } };
}

const formatInr = (p) => `${p.currency === 'INR' ? '₹' : `${p.currency} `}${(p.amount / 100).toLocaleString('en-IN', { minimumFractionDigits: p.amount % 100 ? 2 : 0 })}`;

const publicPayment = (p) => ({
  id: String(p._id), paymentId: p.paymentId, orderId: p.orderId, amount: p.amount, currency: p.currency, status: p.status, method: p.method,
  customerId: p.customerId ? String(p.customerId) : undefined, createdAt: p.razorpayCreatedAt || p.createdAt,
});

/** Recompute a payment's refunded amount from the Refund collection (source of truth) and move its status up. */
export async function reconcileRefunds(paymentId) {
  const refunds = await Refund.find({ paymentId, status: { $ne: 'failed' } }).select('amount').lean();
  const total = refunds.reduce((s, r) => s + r.amount, 0);
  const payment = await Payment.findOne({ paymentId });
  if (!payment) return null;
  if (total <= 0 && !payment.amountRefunded) return payment;
  const refunded = Math.max(total, payment.amountRefunded || 0);
  const status = refunded >= payment.amount ? 'refunded' : 'partially_refunded';
  const set = { amountRefunded: refunded };
  if (rank(status) > rank(payment.status)) set.status = status;
  return Payment.findOneAndUpdate({ _id: payment._id }, { $set: set }, { new: true });
}

export async function applyRefundEntity(entity, { createdBy } = {}) {
  if (!entity?.id) throw new Error('Refund entity has no id');
  const status = { processed: 'processed', failed: 'failed' }[entity.status] || 'pending';
  const payment = entity.payment_id ? await Payment.findOne({ paymentId: entity.payment_id }).select('customerId currency').lean() : null;
  const fields = {
    paymentId: entity.payment_id, amount: Number(entity.amount), currency: entity.currency || payment?.currency || 'INR', speed: entity.speed_processed || entity.speed_requested,
    notes: redactDeep(Array.isArray(entity.notes) ? {} : entity.notes || {}), customerId: payment?.customerId,
    ...(status === 'processed' ? { processedAt: new Date() } : {}),
  };
  let before = null;
  let inserted = false;
  try {
    before = await Refund.findOneAndUpdate({ refundId: entity.id }, { $setOnInsert: { refundId: entity.id, status, ...fields, ...(createdBy ? { createdBy } : {}) } }, { upsert: true, new: false });
    inserted = before === null;
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  if (!inserted) {
    // Status only moves pending → processed | failed.
    const allowed = before?.status === 'pending' && status !== 'pending';
    await Refund.updateOne({ refundId: entity.id, ...(allowed ? { status: 'pending' } : {}) }, { $set: allowed ? { status, ...fields } : { speed: fields.speed } });
  }
  const refund = await Refund.findOne({ refundId: entity.id });
  const payment2 = await reconcileRefunds(entity.payment_id);

  if (inserted && status !== 'failed') {
    const customer = refund.customerId ? await Customer.findById(refund.customerId) : null;
    const name = customer ? displayName(customer) : 'Unknown customer';
    await emitEvent('PAYMENT_REFUNDED', {
      customerId: refund.customerId, actorType: createdBy ? 'user' : 'webhook', source: 'payment',
      description: `Refund ${refund.refundId} of ${formatInr(refund)} for payment ${refund.paymentId}`,
      metadata: { refundId: refund.refundId, paymentId: refund.paymentId, amount: refund.amount },
      data: { customer: name, amount: refund.amount, currency: refund.currency, paymentId: refund.paymentId, refundId: refund.refundId },
    });
  }
  if (payment2) emitToPermission('payments:read', 'payment:update', publicPayment(payment2));
  return { refund, created: inserted, payment: payment2 };
}

/* ------------------------------ orders & checkout ------------------------------ */

const toMinor = (major) => Math.round(Number(major) * 100);

/**
 * Create a Razorpay order. `amount` is in MAJOR currency units (e.g. rupees) at the API boundary;
 * everything stored and exchanged with Razorpay is in the smallest unit (paise).
 */
export async function createOrder(input, user) {
  const creds = await requireCredentials('razorpay');
  const amount = toMinor(input.amount);
  if (!Number.isFinite(amount) || amount < 100) throw ApiError.badRequest('Amount must be at least 1.00', 'INVALID_AMOUNT');
  const currency = (input.currency || (await getSection('payments')).defaultCurrency || 'INR').toUpperCase();

  let customer = null;
  if (input.customerId) {
    customer = await Customer.findById(input.customerId);
    if (!customer) throw ApiError.notFound('Customer not found');
  } else if (input.customer && (input.customer.phone || input.customer.email)) {
    ({ customer } = await findOrCreateCustomer({ ...input.customer, source: 'Payment', actor: user }));
  }

  const receipt = (input.receipt || `rcpt_${Date.now().toString(36)}`).slice(0, 40);
  const notes = {};
  for (const [k, v] of Object.entries(input.notes || {}).slice(0, 12)) notes[String(k).slice(0, 40)] = String(v).slice(0, 250);
  if (customer) { notes.customerId = String(customer._id); notes.name = displayName(customer).slice(0, 100); }
  if (input.description) notes.description = String(input.description).slice(0, 250);

  const remote = await client.createOrder({ amount, currency, receipt, notes }, creds);
  const order = await PaymentOrder.create({
    orderId: remote.id, amount: remote.amount, currency: remote.currency, receipt: remote.receipt, status: remote.status === 'paid' ? 'paid' : 'created',
    notes, customerId: customer?._id, createdBy: user.id,
  });
  await emitEvent('PAYMENT_CREATED', {
    customerId: customer?._id, actor: actorOf(user), actorType: 'user', source: 'payment', description: `${user.name} created order ${order.orderId} for ${formatInr({ amount, currency })}`,
    metadata: { orderId: order.orderId, amount, currency }, data: { customer: customer ? displayName(customer) : undefined, amount, currency, orderId: order.orderId },
  });
  return {
    order,
    checkout: {
      keyId: creds.keyId, orderId: order.orderId, amount: order.amount, currency: order.currency, name: (await getSection('general')).companyName,
      description: input.description || `Order ${order.receipt}`,
      prefill: customer ? { name: displayName(customer), email: customer.email, contact: customer.phone ? `+${customer.phone}` : undefined } : {},
    },
  };
}

/**
 * Verify a checkout result. The client-provided signature is checked with HMAC-SHA256(keySecret, "order|payment"),
 * then the payment is fetched from Razorpay so the stored status/amount come from the provider, never the browser.
 */
export async function verifyPayment({ orderId, paymentId, signature }, user) {
  const creds = await requireCredentials('razorpay');
  const expected = hmacSha256Hex(creds.keySecret, `${orderId}|${paymentId}`);
  if (!safeEqual(signature, expected)) {
    await emitEvent('PAYMENT_FAILED', {
      actor: actorOf(user), actorType: 'user', source: 'payment', description: `Checkout signature verification failed for order ${orderId}`,
      metadata: { orderId, paymentId }, data: { orderId, paymentId, reason: 'Signature verification failed', customer: 'Unknown', amount: undefined },
    });
    throw ApiError.badRequest('Payment signature verification failed', 'INVALID_SIGNATURE');
  }
  const order = await PaymentOrder.findOne({ orderId });
  if (!order) throw ApiError.notFound('Unknown order', 'ORDER_NOT_FOUND');
  const remote = await client.fetchPayment(paymentId, creds);
  if (remote.order_id !== orderId) throw ApiError.badRequest('Payment does not belong to this order', 'ORDER_MISMATCH');
  if (Number(remote.amount) !== order.amount) throw ApiError.badRequest('Payment amount does not match the order', 'AMOUNT_MISMATCH');
  const { payment } = await applyPaymentEntity(remote, { verifiedByClient: true });
  await recordEvent({ type: 'checkout.verified', paymentId, orderId, payload: { status: payment.status } });
  return payment;
}

/* ------------------------------ webhook ------------------------------ */

/** Process a verified Razorpay webhook payload. Idempotency is enforced by the caller (WebhookEvent). */
export async function processRazorpayEvent(body) {
  const type = body?.event;
  const eventId = body?.__eventId;
  const p = body?.payload || {};
  const paymentEntity = p.payment?.entity;
  const orderEntity = p.order?.entity;
  const refundEntity = p.refund?.entity;

  if (!type) return { ignored: true, result: 'no event type' };

  if (type.startsWith('payment.') && paymentEntity) {
    const { payment, transition } = await applyPaymentEntity(paymentEntity);
    await recordEvent({ eventId, type, paymentId: payment.paymentId, orderId: payment.orderId, payload: body });
    return { result: `payment ${transition.from ?? 'new'} → ${transition.to}` };
  }
  if (type === 'order.paid') {
    if (paymentEntity) await applyPaymentEntity(paymentEntity);
    if (orderEntity) {
      await PaymentOrder.updateOne({ orderId: orderEntity.id }, { $set: { status: 'paid', amountPaid: orderEntity.amount_paid, attempts: orderEntity.attempts, paidAt: new Date(), ...(paymentEntity ? { paymentId: paymentEntity.id } : {}) } });
    }
    await recordEvent({ eventId, type, paymentId: paymentEntity?.id, orderId: orderEntity?.id, payload: body });
    return { result: 'order paid' };
  }
  if (type.startsWith('refund.') && refundEntity) {
    if (paymentEntity) await applyPaymentEntity(paymentEntity);
    const { refund } = await applyRefundEntity(refundEntity);
    await recordEvent({ eventId, type, paymentId: refund.paymentId, refundId: refund.refundId, payload: body });
    return { result: `refund ${refund.status}` };
  }
  await recordEvent({ eventId, type, paymentId: paymentEntity?.id, orderId: orderEntity?.id, payload: body });
  return { ignored: true, result: `unhandled event ${type}` };
}

/* ------------------------------ refunds ------------------------------ */

export async function refundPayment(id, { amount, reason, speed }, user) {
  const payment = await findPayment(id);
  if (!['captured', 'partially_refunded'].includes(payment.status)) throw ApiError.conflict('Only captured payments can be refunded', 'NOT_REFUNDABLE');
  const remaining = payment.amount - (payment.amountRefunded || 0);
  const minor = amount === undefined || amount === null ? remaining : toMinor(amount);
  if (!Number.isFinite(minor) || minor < 100) throw ApiError.badRequest('Refund amount must be at least 1.00', 'INVALID_AMOUNT');
  if (minor > remaining) throw ApiError.badRequest('Refund exceeds the refundable balance', 'REFUND_EXCEEDS_BALANCE', { remaining });

  const remote = await client.refundPayment(payment.paymentId, { amount: minor, speed: speed || 'normal', notes: reason ? { reason: String(reason).slice(0, 200) } : undefined });
  const { refund } = await applyRefundEntity(remote, { createdBy: user.id });
  if (reason) await Refund.updateOne({ _id: refund._id }, { $set: { reason } });
  return { refund: await Refund.findById(refund._id), payment: await Payment.findById(payment._id) };
}

/* ------------------------------ queries ------------------------------ */

async function findPayment(id) {
  const payment = mongoose.isValidObjectId(id) && /^[a-f\d]{24}$/i.test(String(id)) ? await Payment.findById(id) : await Payment.findOne({ paymentId: id });
  if (!payment) throw ApiError.notFound('Payment not found');
  return payment;
}

export async function getPayment(id) {
  const payment = await findPayment(id);
  const [customer, order, refunds, events] = await Promise.all([
    payment.customerId ? Customer.findById(payment.customerId).select('firstName lastName phone email').lean() : null,
    payment.orderId ? PaymentOrder.findOne({ orderId: payment.orderId }).lean() : null,
    Refund.find({ paymentId: payment.paymentId }).sort({ createdAt: -1 }).lean(),
    PaymentEvent.find({ paymentId: payment.paymentId }).sort({ createdAt: 1 }).select('-payload').lean(),
  ]);
  return { payment, customer, order, refunds, events };
}

export async function listPayments(query = {}) {
  const pg = getPagination(query);
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.method) filter.method = query.method;
  if (query.customerId) filter.customerId = query.customerId;
  if (query.from || query.to) {
    filter.razorpayCreatedAt = {};
    if (query.from) filter.razorpayCreatedAt.$gte = new Date(query.from);
    if (query.to) filter.razorpayCreatedAt.$lt = new Date(query.to);
  }
  if (query.q) {
    const rx = { $regex: escapeRegex(query.q), $options: 'i' };
    const customers = await Customer.find({ $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }] }).select('_id').limit(100).lean();
    filter.$or = [{ paymentId: rx }, { orderId: rx }, { email: rx }, { contact: rx }, { customerId: { $in: customers.map((c) => c._id) } }];
  }
  const [items, total] = await Promise.all([
    Payment.find(filter).sort({ razorpayCreatedAt: -1, createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('customerId', 'firstName lastName email phone').lean(),
    Payment.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

export async function listOrders(query = {}) {
  const pg = getPagination(query);
  const filter = {};
  if (query.status) filter.status = query.status;
  const [items, total] = await Promise.all([
    PaymentOrder.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('customerId', 'firstName lastName').lean(),
    PaymentOrder.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

export async function listRefunds(query = {}) {
  const pg = getPagination(query);
  const filter = {};
  if (query.status) filter.status = query.status;
  const [items, total] = await Promise.all([
    Refund.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('customerId', 'firstName lastName').lean(),
    Refund.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

/** Aggregates computed in JS (portable across MongoDB-compatible engines). */
export async function paymentStats(from, to) {
  const rows = await Payment.find({ razorpayCreatedAt: { $gte: from, $lt: to } }).select('amount amountRefunded status currency method').lean();
  const s = { revenue: 0, gross: 0, refunded: 0, successful: 0, failed: 0, total: rows.length, averageValue: 0, currency: rows[0]?.currency || 'INR', byMethod: {} };
  for (const r of rows) {
    if (['captured', 'partially_refunded', 'refunded'].includes(r.status)) {
      s.successful += 1;
      s.gross += r.amount;
      s.refunded += r.amountRefunded || 0;
      s.byMethod[r.method || 'unknown'] = (s.byMethod[r.method || 'unknown'] || 0) + r.amount;
    } else if (r.status === 'failed') s.failed += 1;
  }
  s.revenue = s.gross - s.refunded;
  s.averageValue = s.successful ? Math.round(s.gross / s.successful) : 0;
  return s;
}

export async function razorpayWebhookConfigured() {
  const { values } = await getRawCredentials('razorpay');
  return Boolean(values.webhookSecret);
}
