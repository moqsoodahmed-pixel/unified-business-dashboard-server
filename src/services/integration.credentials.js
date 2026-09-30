import { Integration } from '../models/index.js';
import { TYPES, typeOf, fieldsOf, isBuiltin } from '../integrations/registry.js';
import { getAccountDef, listAccountDefs } from '../integrations/accounts.js';
import { decrypt } from '../utils/crypto.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const TTL_MS = 15_000;
const cache = new Map();

export const invalidateCredentials = (provider) => (provider ? cache.delete(provider) : cache.clear());

/**
 * Resolve the effective values for an account:
 *   environment variables (built-in accounts only)  <  values saved from the dashboard.
 * Returns { values, disabled, sources, missing }. Secrets are decrypted here and must never leave the server.
 */
export async function getRawCredentials(provider) {
  const hit = cache.get(provider);
  if (hit && hit.exp > Date.now()) return hit.val;

  const def = await getAccountDef(provider);
  if (!def) return { values: {}, sources: {}, disabled: true, missing: true };

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

/** `provider` may be an account key or a type key. */
export const isComplete = (provider, values) => {
  const fields = TYPES[provider] ? TYPES[provider].fields : fieldsOf(provider);
  return fields.filter((f) => f.required).every((f) => values[f.key]);
};

/** Credentials ready for use, or null when missing/incomplete/disabled. */
export async function getCredentials(provider) {
  const { values, disabled, missing } = await getRawCredentials(provider);
  if (missing || disabled || !isComplete(provider, values)) return null;
  return values;
}

export async function requireCredentials(provider) {
  const creds = await getCredentials(provider);
  if (!creds) {
    const def = await getAccountDef(provider);
    throw ApiError.notConfigured(def?.label || TYPES[typeOf(provider)]?.label || provider);
  }
  return creds;
}

/** Every account of a type that is configured and enabled, with its credentials. */
export async function configuredAccounts(type) {
  const out = [];
  for (const def of await listAccountDefs(type)) {
    const creds = await getCredentials(def.key);
    if (creds) out.push({ ...def, creds });
  }
  return out;
}

/**
 * Pick the account to use for a type.
 *  - `requested` given and `strict` → exactly that account (error if missing, wrong type or not configured).
 *  - `requested` given, not strict → that account when usable, otherwise the default.
 *  - otherwise the account marked as default, else the built-in account, else the first configured one.
 * Returns { key, label, creds }.
 */
export async function resolveAccount(type, requested, { strict = true } = {}) {
  if (requested) {
    if (typeOf(requested) !== type) {
      if (strict) throw ApiError.badRequest(`Unknown ${TYPES[type].label} account`, 'UNKNOWN_ACCOUNT');
    } else {
      const creds = await getCredentials(requested);
      if (creds) return { key: requested, label: (await getAccountDef(requested))?.label || requested, creds };
      if (strict) await requireCredentials(requested); // throws "not configured" / unknown
    }
  }
  const ready = await configuredAccounts(type);
  if (!ready.length) throw ApiError.notConfigured(TYPES[type].label);
  const pick = ready.find((a) => a.isDefault) || ready.find((a) => isBuiltin(a.key)) || ready[0];
  return { key: pick.key, label: pick.label, creds: pick.creds };
}
