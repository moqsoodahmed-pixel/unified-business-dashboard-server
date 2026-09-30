import crypto from 'node:crypto';
import { Integration } from '../models/index.js';
import { PROVIDERS, PROVIDER_KEYS, TYPES, isBuiltin, typeOf, fieldsOf, isAccountKey } from './registry.js';

/**
 * Account directory: built-in accounts from the registry plus the extra accounts created from the dashboard
 * (Integration documents with `custom: true`). Short cache so hot paths (sending, webhooks) stay cheap.
 */
const TTL_MS = 15_000;
let cache = null;

export const invalidateAccounts = () => { cache = null; };

async function customDocs() {
  if (cache && cache.exp > Date.now()) return cache.docs;
  const docs = await Integration.find({ custom: true }).select('provider type label isDefault createdAt').sort({ createdAt: 1 }).lean();
  cache = { docs, exp: Date.now() + TTL_MS };
  return docs;
}

async function metaDocs() {
  // label / isDefault overrides for built-in accounts
  return Integration.find({ provider: { $in: PROVIDER_KEYS } }).select('provider label isDefault').lean();
}

const webhookPathFor = (key, type) => (TYPES[type]?.webhook ? (PROVIDERS[key]?.webhookPath || `/api/webhooks/${type}/${key}`) : null);

function defOf(key, doc) {
  const type = typeOf(key);
  const builtin = isBuiltin(key);
  return {
    key, type, builtin,
    label: doc?.label || PROVIDERS[key]?.label || `${TYPES[type].label} account`,
    description: PROVIDERS[key]?.description || TYPES[type].description,
    fields: fieldsOf(key),
    webhookPath: webhookPathFor(key, type),
    isDefault: Boolean(doc?.isDefault),
  };
}

/** Definition of one account, or null when the key is unknown / the custom account was deleted. */
export async function getAccountDef(key) {
  if (!isAccountKey(key)) return null;
  if (isBuiltin(key)) {
    const doc = await Integration.findOne({ provider: key }).select('label isDefault').lean();
    return defOf(key, doc);
  }
  const doc = (await customDocs()).find((d) => d.provider === key);
  return doc ? defOf(key, doc) : null;
}

/** All accounts, optionally of one type. Built-in accounts first, then custom ones in creation order. */
export async function listAccountDefs(type) {
  const [custom, meta] = await Promise.all([customDocs(), metaDocs()]);
  const metaByKey = new Map(meta.map((m) => [m.provider, m]));
  const all = [
    ...PROVIDER_KEYS.map((k) => defOf(k, metaByKey.get(k))),
    ...custom.filter((d) => typeOf(d.provider)).map((d) => defOf(d.provider, d)),
  ];
  return type ? all.filter((a) => a.type === type) : all;
}

export const newAccountKey = (type) => `${type}_${crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(6, '0').slice(0, 8)}`;
