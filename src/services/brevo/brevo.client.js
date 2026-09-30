import { httpJson, ProviderError } from '../../utils/http.js';
import { requireCredentials } from '../integration.credentials.js';
import { trackCall } from '../integration.service.js';

const BASE = 'https://api.brevo.com/v3';
const P = 'Brevo';

function check(res) {
  if (!res.ok) {
    const msg = res.data?.message || res.data?.code || `HTTP ${res.status}`;
    throw new ProviderError(P, `Brevo rejected the request: ${msg}`, { providerStatus: res.status, providerCode: res.data?.code, retriable: res.status >= 500 });
  }
  return res;
}
const h = (c) => ({ 'api-key': c.apiKey });

export async function getAccount(creds, provider = 'brevo') {
  const c = creds || (await requireCredentials(provider));
  const res = check(await httpJson(`${BASE}/account`, { headers: h(c), provider: P, secrets: [c.apiKey] }));
  return res.data;
}

/**
 * `provider` is 'brevo' (account 1) or 'brevo2' (account 2); it decides which stored credentials are used and which
 * Integrations card records the success/failure.
 * POST /v3/smtp/email.  payload: { sender, to, cc, bcc, subject, htmlContent, textContent,
 * templateId, params, attachment:[{name, content(base64)}], replyTo, tags }
 */
export async function sendEmail(payload, creds, provider = 'brevo') {
  const c = creds || (await requireCredentials(provider));
  return trackCall(provider, async () => {
    const res = check(await httpJson(`${BASE}/smtp/email`, { method: 'POST', headers: h(c), body: payload, provider: P, secrets: [c.apiKey] }));
    return { messageId: res.data?.messageId || res.data?.messageIds?.[0], raw: res.data };
  });
}

export async function listRemoteTemplates({ limit = 50, offset = 0 } = {}, creds, provider = 'brevo') {
  const c = creds || (await requireCredentials(provider));
  const res = check(await httpJson(`${BASE}/smtp/templates`, { headers: h(c), query: { templateStatus: true, limit, offset, sort: 'desc' }, provider: P, secrets: [c.apiKey] }));
  return res.data;
}
