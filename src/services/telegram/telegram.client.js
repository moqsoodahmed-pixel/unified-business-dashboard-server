import { httpJson, ProviderError } from '../../utils/http.js';
import { requireCredentials } from '../integration.credentials.js';

const P = 'Telegram';

async function api(token, method, body) {
  const res = await httpJson(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: body || {}, provider: P, secrets: [token], timeoutMs: 12000 });
  if (!res.ok || res.data?.ok === false) {
    const err = new ProviderError(P, `Telegram rejected the request: ${res.data?.description || `HTTP ${res.status}`}`, {
      providerStatus: res.status, providerCode: res.data?.error_code, retriable: res.status === 429 || res.status >= 500,
    });
    err.retryAfter = res.data?.parameters?.retry_after;
    throw err;
  }
  return res.data.result;
}

export async function getMe(creds) {
  const c = creds || (await requireCredentials('telegram'));
  return api(c.botToken, 'getMe');
}

export async function sendMessage({ chatId, text }, creds) {
  const c = creds || (await requireCredentials('telegram'));
  return api(c.botToken, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

/** Recent updates: lets an admin discover a chat ID after messaging the bot. */
export async function getUpdates(creds) {
  const c = creds || (await requireCredentials('telegram'));
  return api(c.botToken, 'getUpdates', { limit: 20, timeout: 0 });
}
