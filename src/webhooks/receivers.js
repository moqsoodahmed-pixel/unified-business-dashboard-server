import { PROCESSORS } from './processors.js';
import { verifySharedSecret, verifyRazorpaySignature, runWebhook, hashPayload, recordRejected } from '../services/webhook.service.js';
import { normalizeMsg91, msg91EventId } from '../services/msg91/whatsapp.parser.js';
import { brevoEventId, brevoEventName } from '../services/brevo/email.service.js';
import { emitEvent } from '../services/event.bus.js';
import { ok } from '../utils/response.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../config/logger.js';

const MAX_BATCH = 200;
const rawOf = (req) => (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})));

function parseJson(raw) {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw ApiError.badRequest('Webhook body is not valid JSON', 'BAD_JSON');
  }
}

async function authenticate(provider, req, raw, verify) {
  try {
    await verify();
  } catch (err) {
    await recordRejected({ provider, reason: err.message, ip: req.ip, endpoint: req.originalUrl.split('?')[0], rawBody: raw });
    logger.warn({ provider, ip: req.ip, code: err.errorCode }, 'webhook rejected');
    throw err;
  }
}

/** Shared handling for providers whose payload is one object or an array of objects (MSG91, Brevo). */
async function handleItems(provider, req, res, { describe }) {
  const raw = rawOf(req);
  await authenticate(provider, req, raw, () => verifySharedSecret(provider, req));
  const body = parseJson(raw);
  const items = (Array.isArray(body) ? body : body?.events && Array.isArray(body.events) ? body.events : [body]).filter((i) => i && typeof i === 'object');
  if (!items.length) throw ApiError.badRequest('Webhook contained no events', 'EMPTY_WEBHOOK');
  if (items.length > MAX_BATCH) throw ApiError.badRequest(`Batch too large (max ${MAX_BATCH})`, 'BATCH_TOO_LARGE');

  const summary = { received: items.length, processed: 0, ignored: 0, duplicates: 0, failed: 0 };
  for (const item of items) {
    const payloadHash = hashPayload(item);
    const { eventId, eventType } = describe(item, payloadHash);
    try {
      const out = await runWebhook({ provider, eventId, eventType, payloadHash, payload: item, endpoint: req.originalUrl.split('?')[0], ip: req.ip }, PROCESSORS[provider]);
      if (out.duplicate) summary.duplicates += 1;
      else if (out.status === 'ignored') summary.ignored += 1;
      else summary.processed += 1;
    } catch {
      summary.failed += 1; // already recorded + alerted by runWebhook; acknowledged so the provider does not hammer us
    }
  }
  return summary;
}

export async function msg91Receiver(req, res) {
  const summary = await handleItems('msg91', req, res, {
    describe: (item, hash) => {
      const n = normalizeMsg91(item);
      return { eventId: msg91EventId(n, hash), eventType: n.kind === 'status' ? `status.${n.status}` : n.kind };
    },
  });
  if (summary.processed) {
    await emitEvent('WEBHOOK_RECEIVED', { actorType: 'webhook', source: 'webhook', description: `MSG91 webhook: ${summary.processed} event(s) processed`, metadata: { provider: 'msg91', ...summary } });
  }
  return ok(res, summary, 'Webhook accepted');
}

const brevoReceiverFor = (provider) => async (req, res) => {
  const summary = await handleItems(provider, req, res, {
    describe: (item, hash) => ({ eventId: brevoEventId(item, hash), eventType: brevoEventName(item) || 'unknown' }),
  });
  return ok(res, summary, 'Webhook accepted');
};
/** Each Brevo account has its own webhook URL + bearer token so events are authenticated per account. */
export const brevoReceiver = brevoReceiverFor('brevo');
export const brevo2Receiver = brevoReceiverFor('brevo2');

/** Razorpay: signature over the RAW body is mandatory. Processing failures return 500 so Razorpay retries. */
export async function razorpayReceiver(req, res) {
  const raw = rawOf(req);
  await authenticate('razorpay', req, raw, () => verifyRazorpaySignature(raw, req.headers['x-razorpay-signature']));
  const body = parseJson(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !body.event) throw ApiError.badRequest('Unexpected Razorpay payload', 'BAD_PAYLOAD');

  const eventId = String(req.headers['x-razorpay-event-id'] || `body:${hashPayload(raw)}`);
  body.__eventId = eventId;
  let out;
  try {
    out = await runWebhook(
      { provider: 'razorpay', eventId, eventType: body.event, payloadHash: hashPayload(raw), payload: body, endpoint: req.originalUrl.split('?')[0], ip: req.ip },
      PROCESSORS.razorpay
    );
  } catch (err) {
    throw new ApiError(500, 'Webhook processing failed', 'WEBHOOK_PROCESSING_FAILED');
  }
  if (!out.duplicate) {
    await emitEvent('WEBHOOK_RECEIVED', { actorType: 'webhook', source: 'webhook', description: `Razorpay webhook ${body.event} ${out.status}`, metadata: { provider: 'razorpay', eventType: body.event, eventId } });
  }
  return ok(res, { duplicate: out.duplicate, status: out.status }, out.duplicate ? 'Duplicate webhook ignored' : 'Webhook processed');
}
