import { WebhookEvent } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { safeEqual, sha256, hmacSha256Hex } from '../utils/crypto.js';
import { getRawCredentials } from './integration.credentials.js';
import { typeOf, isType } from '../integrations/registry.js';
import { emitEvent } from './event.bus.js';
import { env, isProd } from '../config/env.js';
import { redactDeep } from '../utils/redact.js';
import { getPagination, pageMeta } from '../utils/pagination.js';
import { logger } from '../config/logger.js';

const STALE_PROCESSING_MS = 5 * 60 * 1000;

/* ------------------------------ authentication ------------------------------ */

function tokenFromRequest(req) {
  const h = req.headers;
  if (h['x-webhook-secret']) return String(h['x-webhook-secret']);
  const auth = h.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query?.token) return String(req.query.token);
  return null;
}

/** Shared-secret check for providers that don't sign payloads (MSG91, Brevo). */
export async function verifySharedSecret(provider, req) {
  const { values, missing } = await getRawCredentials(provider);
  if (missing) throw ApiError.notFound('Unknown webhook endpoint', 'UNKNOWN_ACCOUNT');
  const secret = values.webhookSecret;
  if (!secret) {
    if (env.ALLOW_UNSIGNED_WEBHOOKS && !isProd) return true;
    throw new ApiError(503, `${provider} webhook secret is not configured`, 'WEBHOOK_SECRET_MISSING');
  }
  if (!safeEqual(tokenFromRequest(req), secret)) throw ApiError.unauthorized('Invalid webhook credentials', 'WEBHOOK_AUTH_FAILED');
  return true;
}

/** Razorpay signs the raw body: HMAC-SHA256(rawBody, webhookSecret), hex, header X-Razorpay-Signature. */
export async function verifyRazorpaySignature(rawBody, signature, account = 'razorpay') {
  const { values, missing } = await getRawCredentials(account);
  if (missing) throw ApiError.notFound('Unknown webhook endpoint', 'UNKNOWN_ACCOUNT');
  if (!values.webhookSecret) throw new ApiError(503, 'Razorpay webhook secret is not configured', 'WEBHOOK_SECRET_MISSING');
  const expected = hmacSha256Hex(values.webhookSecret, rawBody);
  if (!safeEqual(signature, expected)) throw ApiError.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
  return true;
}

/* ------------------------------ idempotency ------------------------------ */

export const hashPayload = (raw) => sha256(typeof raw === 'string' || Buffer.isBuffer(raw) ? raw : JSON.stringify(raw));

/**
 * Atomically claim an event. The unique (provider, eventId) index makes this safe under concurrency.
 * Returns { claimed, record }. Completed/processing events are never claimed again; failed ones may be re-claimed.
 */
export async function claimWebhook({ provider, eventId, eventType, payloadHash, payload, endpoint, ip }) {
  try {
    const record = await WebhookEvent.create({
      provider, eventId, eventType, payloadHash, payload, endpoint, ip, status: 'processing', attempts: 1, receivedAt: new Date(),
    });
    return { claimed: true, record };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await WebhookEvent.findOne({ provider, eventId });
    if (!existing) return { claimed: false, record: null };
    if (existing.status === 'failed') {
      const won = await WebhookEvent.findOneAndUpdate({ _id: existing._id, status: 'failed' }, { $set: { status: 'processing', error: null }, $inc: { attempts: 1 } }, { new: true });
      if (won) return { claimed: true, record: won, retry: true };
    }
    if (existing.status === 'processing' && Date.now() - existing.updatedAt.getTime() > STALE_PROCESSING_MS) {
      const won = await WebhookEvent.findOneAndUpdate({ _id: existing._id, status: 'processing', updatedAt: existing.updatedAt }, { $inc: { attempts: 1 } }, { new: true });
      if (won) return { claimed: true, record: won, retry: true };
    }
    return { claimed: false, record: existing };
  }
}

/**
 * Run `handler(payload)` under the idempotency guard.
 * Returns { duplicate, status, result } and rethrows handler errors after recording them.
 */
export async function runWebhook(meta, handler) {
  const { claimed, record } = await claimWebhook(meta);
  if (!claimed) return { duplicate: true, status: record?.status, id: record?._id };

  const started = Date.now();
  try {
    const out = await handler(meta.payload, meta.provider);
    const ignored = out?.ignored === true;
    await WebhookEvent.updateOne(
      { _id: record._id },
      { $set: { status: ignored ? 'ignored' : 'completed', processedAt: new Date(), processingMs: Date.now() - started, result: out?.result || (ignored ? 'ignored' : 'ok'), error: null } }
    );
    return { duplicate: false, status: ignored ? 'ignored' : 'completed', id: record._id, result: out?.result };
  } catch (err) {
    const message = String(err?.message || 'Processing failed').slice(0, 500);
    await WebhookEvent.updateOne({ _id: record._id }, { $set: { status: 'failed', processedAt: new Date(), processingMs: Date.now() - started, error: message } });
    logger.error({ err: message, provider: meta.provider, eventId: meta.eventId }, 'webhook processing failed');
    await emitEvent('WEBHOOK_FAILED', {
      actorType: 'webhook', source: 'webhook', description: `${meta.provider} webhook ${meta.eventType || ''} failed: ${message}`,
      metadata: { provider: meta.provider, eventId: meta.eventId, eventType: meta.eventType },
      data: { provider: meta.provider, eventType: meta.eventType, error: message },
    });
    if (typeOf(meta.provider) === 'razorpay') {
      await emitEvent('PAYMENT_WEBHOOK_FAILED', { source: 'payment', actorType: 'webhook', description: `Razorpay webhook failed: ${message}`, data: { eventType: meta.eventType, eventId: meta.eventId, error: message } });
    }
    err.webhookRecordId = record._id;
    throw err;
  }
}

/** Keep a trace of unauthenticated / invalid deliveries without making them retryable. */
export async function recordRejected({ provider, reason, ip, endpoint, rawBody }) {
  const hash = hashPayload(rawBody || '');
  await WebhookEvent.create({
    provider, eventId: `rejected:${hash.slice(0, 16)}:${Date.now()}`, eventType: 'rejected', payloadHash: hash,
    status: 'rejected', signatureValid: false, endpoint, ip, error: reason, receivedAt: new Date(),
  }).catch(() => {});
}

/* ------------------------------ admin / webhook center ------------------------------ */

export async function listWebhookEvents(query = {}) {
  const pg = getPagination(query, { defaultLimit: 30, maxLimit: 100 });
  const filter = {};
  // A type (e.g. `brevo`) matches every account of that type; an account key matches exactly.
  if (query.provider) filter.provider = isType(query.provider) && query.all !== 'false' ? { $regex: `^${query.provider}(2|_[a-z0-9]{4,16})?$` } : query.provider;
  if (query.status) filter.status = query.status;
  if (query.eventType) filter.eventType = query.eventType;
  if (query.from || query.to) {
    filter.receivedAt = {};
    if (query.from) filter.receivedAt.$gte = new Date(query.from);
    if (query.to) filter.receivedAt.$lt = new Date(query.to);
  }
  const [items, total] = await Promise.all([
    WebhookEvent.find(filter).select('-payload').sort({ receivedAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    WebhookEvent.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

export async function getWebhookEvent(id) {
  const e = await WebhookEvent.findById(id).lean();
  if (!e) throw ApiError.notFound('Webhook event not found');
  e.payload = redactDeep(e.payload);
  return e;
}

export async function retryWebhookEvent(id, processors) {
  const e = await WebhookEvent.findById(id);
  if (!e) throw ApiError.notFound('Webhook event not found');
  if (e.status !== 'failed') throw ApiError.conflict('Only failed events can be retried', 'NOT_RETRYABLE');
  const processor = typeof processors === 'function' ? processors(e.provider) : processors[e.provider];
  if (!processor) throw ApiError.badRequest('No processor for this provider');
  return runWebhook({ provider: e.provider, eventId: e.eventId, eventType: e.eventType, payloadHash: e.payloadHash, payload: e.payload, endpoint: e.endpoint, ip: e.ip }, processor);
}

export async function webhookStats(from, to) {
  const rows = await WebhookEvent.find({ receivedAt: { $gte: from, $lt: to } }).select('provider status receivedAt').lean();
  return rows;
}
