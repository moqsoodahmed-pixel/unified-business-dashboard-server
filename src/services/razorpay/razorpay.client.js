import { httpJson, ProviderError } from '../../utils/http.js';
import { requireCredentials } from '../integration.credentials.js';
import { trackCall } from '../integration.service.js';

const BASE = 'https://api.razorpay.com/v1';
const P = 'Razorpay';

const auth = (c) => ({ Authorization: `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString('base64')}` });

function check(res) {
  if (!res.ok) {
    const e = res.data?.error || {};
    throw new ProviderError(P, `Razorpay rejected the request: ${e.description || `HTTP ${res.status}`}`, {
      providerStatus: res.status, providerCode: e.code, retriable: res.status >= 500,
    });
  }
  return res.data;
}
const call = (c, path, opts = {}) =>
  httpJson(`${BASE}${path}`, { headers: auth(c), provider: P, secrets: [c.keySecret], ...opts });

export async function ping(creds) {
  const c = creds || (await requireCredentials('razorpay'));
  return check(await call(c, '/payments', { query: { count: 1 } }));
}

export async function createOrder({ amount, currency = 'INR', receipt, notes }, creds) {
  const c = creds || (await requireCredentials('razorpay'));
  return trackCall('razorpay', async () => check(await call(c, '/orders', { method: 'POST', body: { amount, currency, receipt, notes } })));
}

export async function fetchPayment(paymentId, creds) {
  const c = creds || (await requireCredentials('razorpay'));
  return trackCall('razorpay', async () => check(await call(c, `/payments/${encodeURIComponent(paymentId)}`)));
}

export async function refundPayment(paymentId, { amount, speed = 'normal', notes, receipt }, creds) {
  const c = creds || (await requireCredentials('razorpay'));
  const body = { ...(amount ? { amount } : {}), speed, ...(notes ? { notes } : {}), ...(receipt ? { receipt } : {}) };
  return trackCall('razorpay', async () => check(await call(c, `/payments/${encodeURIComponent(paymentId)}/refund`, { method: 'POST', body })));
}
