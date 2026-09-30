import { Integration } from '../models/index.js';
import { PROVIDERS } from '../integrations/registry.js';
import { decrypt } from '../utils/crypto.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const TTL_MS = 15_000;
const cache = new Map();

export const invalidateCredentials = (provider) => (provider ? cache.delete(provider) : cache.clear());

/**
 * Resolve the effective values for a provider:
 *   environment variables  <  values saved from the dashboard.
 * Returns { values, disabled, sources }. Secrets are decrypted here and must never leave the server.
 */
export async function getRawCredentials(provider) {
  const hit = cache.get(provider);
  if (hit && hit.exp > Date.now()) return hit.val;

  const def = PROVIDERS[provider];
  const values = {};
  const sources = {};
  for (const f of def.fields) {
    if (f.env && env[f.env]) { values[f.key] = env[f.env]; sources[f.key] = 'env'; }
  }
  const doc = await Integration.findOne({ provider }).select('+secrets').lean();
  if (doc) {
    for (const [k, v] of Object.entries(doc.config || {})) if (v !== undefined && v !== '') { values[k] = v; sources[k] = 'dashboard'; }
    const secrets = doc.secrets instanceof Map ? Object.fromEntries(doc.secrets) : doc.secrets || {};
    for (const [k, enc] of Object.entries(secrets)) {
      try { values[k] = decrypt(enc); sources[k] = 'dashboard'; } catch { /* corrupted or key rotated: treat as unset */ }
    }
  }
  const val = { values, sources, disabled: doc?.enabled === false };
  cache.set(provider, { val, exp: Date.now() + TTL_MS });
  return val;
}

export const isComplete = (provider, values) =>
  PROVIDERS[provider].fields.filter((f) => f.required).every((f) => values[f.key]);

/** Credentials ready for use, or null when missing/incomplete/disabled. */
export async function getCredentials(provider) {
  const { values, disabled } = await getRawCredentials(provider);
  if (disabled || !isComplete(provider, values)) return null;
  return values;
}

export async function requireCredentials(provider) {
  const creds = await getCredentials(provider);
  if (!creds) throw ApiError.notConfigured(PROVIDERS[provider].label);
  return creds;
}
