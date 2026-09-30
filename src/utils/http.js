import { ApiError } from './ApiError.js';
import { scrubSecrets } from './redact.js';

export class ProviderError extends ApiError {
  constructor(provider, message, { status = 502, providerStatus, providerCode, retriable = false } = {}) {
    super(status === 401 || status === 403 ? 502 : 502, message, 'PROVIDER_ERROR');
    this.name = 'ProviderError';
    this.provider = provider;
    this.providerStatus = providerStatus;
    this.providerCode = providerCode;
    this.retriable = retriable;
  }
}

/**
 * Minimal JSON HTTP helper on top of global fetch (Node 20+).
 * Tests replace globalThis.fetch, so always read it lazily.
 */
export async function httpJson(url, { method = 'GET', headers = {}, body, query, timeoutMs = 15000, provider = 'provider', secrets = [] } = {}) {
  const u = new URL(url);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await globalThis.fetch(u.toString(), {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: ctrl.signal,
    });
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'request timed out' : 'network error';
    throw new ProviderError(provider, `${provider} request failed: ${msg}`, { retriable: true });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { status: res.status, ok: res.ok, data, text: scrubSecrets(text.slice(0, 2000), secrets) };
}
