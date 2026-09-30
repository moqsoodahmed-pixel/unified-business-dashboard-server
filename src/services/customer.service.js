import { Customer, WhatsAppConversation, WhatsAppMessage, Email, Payment, PaymentOrder, ActivityLog } from '../models/index.js';
import { normalizePhone, normalizeEmail, escapeRegex } from '../utils/phone.js';
import { ApiError } from '../utils/ApiError.js';
import { getPagination, pageMeta } from '../utils/pagination.js';
import { emitEvent } from './event.bus.js';

const actorOf = (u) => u && { userId: u.id, name: u.name, role: u.role };

export function splitName(full = '') {
  const parts = String(full).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}
export const displayName = (c) =>
  c ? [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || (c.phone ? `+${c.phone}` : 'Unknown') : 'Unknown';

async function flagDuplicates(a, others) {
  const ids = others.map((o) => o._id).filter((id) => String(id) !== String(a._id));
  if (!ids.length) return;
  await Customer.updateOne({ _id: a._id }, { $addToSet: { possibleDuplicates: { $each: ids } } });
}

/**
 * Safe identity resolution across WhatsApp / Email / Payment.
 * Rules (nothing is ever merged automatically):
 *  1. Phone is the strongest key: an exact normalised match wins.
 *  2. An email is attached to a phone-matched customer only if no other customer owns it.
 *  3. If phone and email point at DIFFERENT customers, both are kept and flagged as possible duplicates.
 *  4. Email-only lookups match only when exactly one customer has that email; otherwise no link is made.
 */
export async function findOrCreateCustomer({ phone, email, name, source = 'API', actor, ip, createIfMissing = true } = {}) {
  const p = normalizePhone(phone);
  const e = normalizeEmail(email);
  if (!p && !e) return { customer: null, created: false, conflict: false };

  const byPhone = p ? await Customer.findOne({ phone: p }) : null;
  const byEmail = e ? await Customer.find({ email: e }).limit(5) : [];
  const { firstName, lastName } = splitName(name);
  let customer = null;
  let conflict = false;
  let created = false;

  if (byPhone) {
    customer = byPhone;
    const others = byEmail.filter((c) => String(c._id) !== String(byPhone._id));
    if (e && !byPhone.email && others.length === 0) {
      byPhone.email = e;
      await byPhone.save();
    } else if (e && byPhone.email !== e && others.length) {
      conflict = true;
      await flagDuplicates(byPhone, others);
    }
    if (!byPhone.firstName && firstName) { byPhone.firstName = firstName; byPhone.lastName = lastName; await byPhone.save(); }
  } else if (p && e && byEmail.length === 1 && !byEmail[0].phone) {
    customer = byEmail[0];
    customer.phone = p;
    await customer.save();
  } else if (!p && e && byEmail.length === 1) {
    customer = byEmail[0];
  } else if (!p && e && byEmail.length > 1) {
    return { customer: null, created: false, conflict: true, ambiguous: true };
  } else if (createIfMissing) {
    conflict = Boolean(p && e && byEmail.length);
    try {
      customer = await Customer.create({
        firstName, lastName, phone: p || undefined, email: p && byEmail.length ? undefined : e || undefined, source, status: 'active',
        lastInteractionAt: new Date(),
      });
      created = true;
    } catch (err) {
      if (err?.code === 11000 && p) customer = await Customer.findOne({ phone: p }); // lost a race: use the winner
      else throw err;
    }
    if (created && conflict) {
      await flagDuplicates(customer, byEmail);
      await Customer.updateMany({ _id: { $in: byEmail.map((b) => b._id) } }, { $addToSet: { possibleDuplicates: customer._id } });
    }
  }

  if (created) {
    await emitEvent('CUSTOMER_CREATED', {
      customerId: customer._id, source: 'customer', actorType: actor ? 'user' : 'system', actor: actorOf(actor), ip,
      description: `New customer ${displayName(customer)} (via ${source})`,
      metadata: { source, phone: customer.phone, email: customer.email },
      data: { name: displayName(customer), phone: customer.phone, email: customer.email, source },
    });
  }
  return { customer, created, conflict };
}

export async function touchCustomer(customerId, at = new Date()) {
  if (customerId) await Customer.updateOne({ _id: customerId }, { $max: { lastInteractionAt: at } });
}

export async function createCustomer(input, actor, ip) {
  const phone = input.phone ? normalizePhone(input.phone) : undefined;
  if (input.phone && !phone) throw ApiError.badRequest('Phone number is not valid', 'INVALID_PHONE');
  const email = input.email ? normalizeEmail(input.email) : undefined;
  if (input.email && !email) throw ApiError.badRequest('Email address is not valid', 'INVALID_EMAIL');
  if (!phone && !email && !input.firstName) throw ApiError.badRequest('Provide at least a name, phone or email');
  if (phone) {
    const existing = await Customer.findOne({ phone });
    if (existing) throw ApiError.conflict('A customer with this phone number already exists', 'DUPLICATE_PHONE', { existingId: String(existing._id) });
  }
  const sameEmail = email ? await Customer.find({ email }).limit(5) : [];
  const customer = await Customer.create({
    firstName: input.firstName || '', lastName: input.lastName || '', phone, email, company: input.company,
    tags: input.tags || [], source: input.source || 'Manual', status: input.status || 'active',
    notes: input.note ? [{ text: input.note, author: actor?.id, authorName: actor?.name }] : [],
    lastInteractionAt: new Date(),
  });
  if (sameEmail.length) {
    await flagDuplicates(customer, sameEmail);
  }
  await emitEvent('CUSTOMER_CREATED', {
    customerId: customer._id, source: 'customer', actorType: 'user', actor: actorOf(actor), ip,
    description: `Customer ${displayName(customer)} created manually`, metadata: { phone, email },
    data: { name: displayName(customer), phone, email, source: customer.source },
  });
  return customer;
}

export async function updateCustomer(id, patch, actor, ip) {
  const customer = await Customer.findById(id);
  if (!customer) throw ApiError.notFound('Customer not found');
  if (patch.phone !== undefined) {
    const phone = patch.phone ? normalizePhone(patch.phone) : undefined;
    if (patch.phone && !phone) throw ApiError.badRequest('Phone number is not valid', 'INVALID_PHONE');
    if (phone && phone !== customer.phone && (await Customer.exists({ phone, _id: { $ne: customer._id } }))) {
      throw ApiError.conflict('Another customer already uses this phone number', 'DUPLICATE_PHONE');
    }
    customer.phone = phone;
    delete patch.phone;
  }
  if (patch.email !== undefined) {
    const email = patch.email ? normalizeEmail(patch.email) : undefined;
    if (patch.email && !email) throw ApiError.badRequest('Email address is not valid', 'INVALID_EMAIL');
    customer.email = email;
    delete patch.email;
  }
  Object.assign(customer, patch);
  await customer.save();
  await emitEvent('CUSTOMER_UPDATED', {
    customerId: customer._id, source: 'customer', actorType: 'user', actor: actorOf(actor), ip,
    description: `Customer ${displayName(customer)} updated`, metadata: { fields: Object.keys(patch) },
    data: { name: displayName(customer), fields: Object.keys(patch).join(', ') },
  });
  return customer;
}

export async function listCustomers(query = {}) {
  const pg = getPagination(query);
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.source) filter.source = query.source;
  if (query.tag) filter.tags = query.tag;
  if (query.assignedTo) filter.assignedTo = query.assignedTo === 'none' ? null : query.assignedTo;
  if (query.q) {
    const tokens = String(query.q).trim().split(/\s+/).filter(Boolean).slice(0, 5);
    filter.$and = tokens.map((t) => {
      const rx = new RegExp(escapeRegex(t.replace(/^\+/, '')), 'i');
      return { $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }, { company: rx }, { tags: rx }] };
    });
  }
  const sortKey = { createdAt: 'createdAt', name: 'firstName', lastInteraction: 'lastInteractionAt' }[query.sort] || 'createdAt';
  const dir = query.order === 'asc' ? 1 : -1;
  const [items, total] = await Promise.all([
    Customer.find(filter).sort({ [sortKey]: dir }).skip(pg.skip).limit(pg.limit).populate('assignedTo', 'name role'),
    Customer.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

export async function getCustomer(id) {
  const c = await Customer.findById(id).populate('assignedTo', 'name role').populate('possibleDuplicates', 'firstName lastName phone email');
  if (!c) throw ApiError.notFound('Customer not found');
  return c;
}

const netPaid = (p) => (p.status === 'captured' ? p.amount : p.status === 'partially_refunded' ? p.amount - (p.amountRefunded || 0) : 0);

/** One-page view of everything known about a customer. */
export async function getCustomerProfile(id, { includePayments = true } = {}) {
  const customer = await getCustomer(id);
  const cid = customer._id;
  const [conversation, waCount, emailCount, emails, payments, orders, timeline] = await Promise.all([
    WhatsAppConversation.findOne({ customerId: cid }).populate('assignedTo', 'name').lean(),
    WhatsAppMessage.countDocuments({ customerId: cid }),
    Email.countDocuments({ customerId: cid }),
    Email.find({ customerId: cid }).sort({ createdAt: -1 }).limit(20).select('subject status to createdAt delivered opened clicked').lean(),
    includePayments ? Payment.find({ customerId: cid }).sort({ createdAt: -1 }).limit(50).lean() : [],
    includePayments ? PaymentOrder.find({ customerId: cid }).sort({ createdAt: -1 }).limit(20).lean() : [],
    ActivityLog.find({ customerId: cid }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);
  const lifetime = payments.reduce((s, p) => s + netPaid(p), 0);
  return {
    customer,
    whatsapp: { conversation, messageCount: waCount },
    email: { count: emailCount, recent: emails },
    payments: includePayments ? { items: payments, orders, lifetimeAmount: lifetime, currency: payments[0]?.currency || 'INR', count: payments.length } : null,
    timeline,
    stats: { whatsappMessages: waCount, emails: emailCount, lifetimePaymentAmount: includePayments ? lifetime : null },
  };
}

export async function addNote(id, text, user) {
  const c = await Customer.findByIdAndUpdate(id, { $push: { notes: { text, author: user.id, authorName: user.name } } }, { new: true });
  if (!c) throw ApiError.notFound('Customer not found');
  return c;
}
export async function deleteNote(id, noteId) {
  const c = await Customer.findByIdAndUpdate(id, { $pull: { notes: { _id: noteId } } }, { new: true });
  if (!c) throw ApiError.notFound('Customer not found');
  return c;
}
export async function addTags(id, tags) {
  const c = await Customer.findByIdAndUpdate(id, { $addToSet: { tags: { $each: tags } } }, { new: true });
  if (!c) throw ApiError.notFound('Customer not found');
  return c;
}
export async function removeTag(id, tag) {
  const c = await Customer.findByIdAndUpdate(id, { $pull: { tags: tag } }, { new: true });
  if (!c) throw ApiError.notFound('Customer not found');
  return c;
}
