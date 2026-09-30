import { httpJson, ProviderError } from '../../utils/http.js';
import { requireCredentials } from '../integration.credentials.js';
import { trackCall } from '../integration.service.js';

const API = 'https://api.msg91.com';
const CONTROL = 'https://control.msg91.com';
const P = 'MSG91';

const errorText = (data, fallback) => {
  const m = data?.message || data?.error || data?.errors || data?.msg;
  if (!m) return fallback;
  return typeof m === 'string' ? m : JSON.stringify(m).slice(0, 200);
};
const failed = (res) => !res.ok || res.data?.hasError === true || res.data?.status === 'fail' || res.data?.type === 'error';

function check(res, secrets) {
  if (failed(res)) {
    throw new ProviderError(P, `MSG91 rejected the request: ${errorText(res.data, `HTTP ${res.status}`)}`, {
      providerStatus: res.status, retriable: res.status >= 500,
    });
  }
  return res;
}

/** Best-effort extraction of MSG91's request/message identifier from the send response. */
export function extractIds(data) {
  const d = data || {};
  const inner = d.data && typeof d.data === 'object' ? d.data : {};
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v) || (typeof vals.find((v) => typeof v === 'number') === 'number' ? String(vals.find((v) => typeof v === 'number')) : undefined);
  return {
    requestId: pick(d.request_id, d.requestId, inner.request_id, inner.requestId, typeof d.data === 'string' ? d.data : undefined, d.id, inner.id),
    messageId: pick(d.message_id, d.uuid, inner.message_id, inner.uuid),
  };
}

const headers = (creds) => ({ authkey: creds.authKey });

/** Template message (usable outside the 24h window). Uses the documented bulk endpoint. */
export async function sendTemplate({ to, name, language = 'en', namespace, variables = [] }, creds, account = 'msg91') {
  const c = creds || (await requireCredentials(account));
  const components = {};
  variables.forEach((v, i) => { components[`body_${i + 1}`] = { type: 'text', value: String(v) }; });
  const body = {
    integrated_number: c.integratedNumber.replace(/^\+/, ''),
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name,
        language: { code: language, policy: 'deterministic' },
        namespace: namespace || c.templateNamespace || null,
        to_and_components: [{ to: [to], components }],
      },
    },
  };
  return trackCall(account, async () => {
    const res = await httpJson(`${API}/api/v5/whatsapp/whatsapp-outbound-message/bulk/`, {
      method: 'POST', headers: headers(c), body, provider: P, secrets: [c.authKey],
    });
    check(res);
    return { raw: res.data, ...extractIds(res.data) };
  });
}

/** Free-form text; only valid inside the customer-service window. */
export async function sendText({ to, text }, creds, account = 'msg91') {
  const c = creds || (await requireCredentials(account));
  return trackCall(account, async () => {
    const res = await httpJson(`${API}/api/v5/whatsapp/whatsapp-outbound-message/`, {
      method: 'POST', headers: headers(c), provider: P, secrets: [c.authKey],
      query: { content_type: 'text', integrated_number: c.integratedNumber.replace(/^\+/, ''), recipient_number: to, text },
    });
    check(res);
    return { raw: res.data, ...extractIds(res.data) };
  });
}

/** Media by public URL (image | video | audio | document). */
export async function sendMedia({ to, type, link, caption, filename }, creds, account = 'msg91') {
  const c = creds || (await requireCredentials(account));
  const media = { link, ...(caption ? { caption } : {}), ...(type === 'document' && filename ? { filename } : {}) };
  return trackCall(account, async () => {
    const res = await httpJson(`${API}/api/v5/whatsapp/whatsapp-outbound-message/`, {
      method: 'POST', headers: headers(c), provider: P, secrets: [c.authKey],
      body: { content_type: type, integrated_number: c.integratedNumber.replace(/^\+/, ''), recipient_number: to, [type]: media },
    });
    check(res);
    return { raw: res.data, ...extractIds(res.data) };
  });
}

/** Lists templates for the integrated number; doubles as a credential check. */
export async function listTemplates(creds, query = {}) {
  const c = creds || (await requireCredentials('msg91'));
  const res = await httpJson(`${CONTROL}/api/v5/whatsapp/get-template-client/${encodeURIComponent(c.integratedNumber.replace(/^\+/, ''))}`, {
    headers: { ...headers(c), 'Content-Type': 'text/plain' }, query, provider: P, secrets: [c.authKey],
  });
  check(res);
  return res.data;
}
