import mongoose from 'mongoose';
import os from 'node:os';
import { Integration } from '../models/index.js';
import { PROVIDERS, PROVIDER_KEYS, isProvider, secretKeys } from '../integrations/registry.js';
import { getRawCredentials, isComplete, invalidateCredentials } from './integration.credentials.js';
import { encrypt } from '../utils/crypto.js';
import { maskIdentifier } from '../utils/redact.js';
import { ApiError } from '../utils/ApiError.js';
import { apiBaseUrl } from '../config/env.js';
import { dbState } from '../config/db.js';
import { emitEvent } from './event.bus.js';

const MASK = '••••••••';

/** Public, secret-free description of a provider. */
export async function getIntegrationView(provider) {
  const def = PROVIDERS[provider];
  const { values, disabled, sources } = await getRawCredentials(provider);
  const doc = await Integration.findOne({ provider }).lean();
  const complete = isComplete(provider, values);

  let status;
  if (disabled) status = 'disconnected';
  else if (!complete) status = 'not_configured';
  else status = doc?.status && doc.status !== 'not_configured' ? doc.status : 'untested';

  const config = {};
  const secretsConfigured = {};
  for (const f of def.fields) {
    if (f.secret) secretsConfigured[f.key] = Boolean(values[f.key]);
    else if (values[f.key]) config[f.key] = f.mask ? maskIdentifier(values[f.key]) : values[f.key];
  }
  const view = {
    provider,
    label: def.label,
    description: def.description,
    status,
    connected: status === 'connected',
    configured: complete && !disabled,
    config,
    secretsConfigured,
    secretConfigured: Object.values(secretsConfigured).some(Boolean),
    secretPlaceholder: MASK,
    sources,
    fields: def.fields.map((f) => ({ key: f.key, label: f.label, secret: Boolean(f.secret), required: Boolean(f.required) })),
    lastSuccessAt: doc?.lastSuccessAt || null,
    lastErrorAt: doc?.lastErrorAt || null,
    lastError: doc?.lastError || null,
    lastTestedAt: doc?.lastTestedAt || null,
    webhookUrl: def.webhookPath ? `${apiBaseUrl()}${def.webhookPath}` : null,
  };
  // Convenience fields matching the documented GET /api/integrations response shape.
  if (config.keyId) view.keyId = config.keyId;
  return view;
}

async function mongoView() {
  let ok = false, latencyMs = null;
  try {
    const t = Date.now();
    await mongoose.connection.db.admin().ping();
    latencyMs = Date.now() - t;
    ok = true;
  } catch { /* reported below */ }
  return {
    provider: 'mongodb', label: 'MongoDB', description: 'Primary application database.',
    status: ok ? 'connected' : 'error', connected: ok, configured: true, readOnly: true,
    config: { database: mongoose.connection.name, host: mongoose.connection.host, state: dbState() },
    secretsConfigured: {}, secretConfigured: false, latencyMs,
    lastSuccessAt: ok ? new Date() : null, lastError: ok ? null : 'Database is not reachable', fields: [],
  };
}

function systemView() {
  const mem = process.memoryUsage();
  return {
    provider: 'system', label: 'System', description: 'Server runtime.', status: 'connected', connected: true,
    configured: true, readOnly: true, secretsConfigured: {}, secretConfigured: false, fields: [],
    config: {
      node: process.version, uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(mem.rss / 1048576), cpuCount: os.cpus().length, environment: process.env.NODE_ENV,
    },
    lastSuccessAt: new Date(), lastError: null,
  };
}

export async function listIntegrations() {
  const views = await Promise.all(PROVIDER_KEYS.map(getIntegrationView));
  return [...views, await mongoView(), systemView()];
}

export async function getView(provider) {
  if (provider === 'mongodb') return mongoView();
  if (provider === 'system') return systemView();
  if (!isProvider(provider)) throw ApiError.notFound('Unknown integration');
  return getIntegrationView(provider);
}

/** Record the outcome of any live provider call so the Integrations page and health check stay honest. */
export async function recordProviderResult(provider, ok, errorMessage, { tested = false } = {}) {
  const prev = await Integration.findOne({ provider }).lean();
  const now = new Date();
  const set = ok
    ? { status: 'connected', lastSuccessAt: now, lastError: null, ...(tested ? { lastTestedAt: now } : {}) }
    : { status: 'error', lastErrorAt: now, lastError: String(errorMessage || 'Unknown error').slice(0, 300), ...(tested ? { lastTestedAt: now } : {}) };
  await Integration.updateOne({ provider }, { $set: set, $setOnInsert: { provider } }, { upsert: true });
  if (!ok && prev?.status !== 'error') {
    await emitEvent('API_FAILURE', {
      source: 'system', description: `${PROVIDERS[provider].label} API call failed: ${set.lastError}`,
      metadata: { provider, error: set.lastError }, data: { provider: PROVIDERS[provider].label, error: set.lastError },
    });
  }
}

/** Wrap a live provider call, recording success/failure. */
export async function trackCall(provider, fn) {
  try {
    const out = await fn();
    await recordProviderResult(provider, true).catch(() => {});
    return out;
  } catch (err) {
    if (err?.name === 'ProviderError') await recordProviderResult(provider, false, err.message).catch(() => {});
    throw err;
  }
}

export async function testConnection(provider, candidate) {
  if (provider === 'mongodb') { const v = await mongoView(); return { ok: v.connected, message: v.connected ? 'Connected successfully' : 'Connection failed', details: { latencyMs: v.latencyMs } }; }
  if (provider === 'system') return { ok: true, message: 'Connected successfully', details: {} };
  if (!isProvider(provider)) throw ApiError.notFound('Unknown integration');

  const { values } = await getRawCredentials(provider);
  const creds = candidate || values;
  if (!isComplete(provider, creds)) {
    return { ok: false, message: `${PROVIDERS[provider].label} is not configured.`, details: {} };
  }
  const { testers } = await import('../integrations/testers.js');
  try {
    const details = await testers[provider](creds);
    if (!candidate) await recordProviderResult(provider, true, null, { tested: true });
    return { ok: true, message: 'Connected successfully', details: details || {} };
  } catch (err) {
    const message = err?.name === 'ProviderError' || err instanceof ApiError ? err.message : 'Connection failed';
    if (!candidate) await recordProviderResult(provider, false, message, { tested: true });
    return { ok: false, message: `Connection failed: ${message}`, details: {} };
  }
}

/**
 * Save credentials from the dashboard. Blank secret inputs keep the stored value.
 * New credentials are tested first and rejected if they fail (unless force=true).
 */
export async function saveIntegration(provider, input, { clear = [], force = false } = {}, user) {
  if (!isProvider(provider)) throw ApiError.notFound('Unknown integration');
  const def = PROVIDERS[provider];
  const { values: current } = await getRawCredentials(provider);
  const next = { ...current };
  const errors = {};

  for (const f of def.fields) {
    const raw = input?.[f.key];
    if (clear.includes(f.key)) { delete next[f.key]; continue; }
    if (raw === undefined || raw === null || raw === '' || raw === MASK) continue; // keep existing
    const parsed = f.schema.safeParse(String(raw).trim());
    if (!parsed.success) errors[f.key] = parsed.error.issues[0].message;
    else next[f.key] = parsed.data;
  }
  if (Object.keys(errors).length) throw ApiError.badRequest('Invalid credentials', 'VALIDATION_ERROR', errors);

  if (isComplete(provider, next) && !force) {
    const result = await testConnection(provider, next);
    if (!result.ok) throw ApiError.unprocessable(result.message, 'CREDENTIAL_TEST_FAILED');
  }

  const config = {};
  const secrets = {};
  for (const f of def.fields) {
    if (next[f.key] === undefined) continue;
    if (f.secret) secrets[f.key] = encrypt(next[f.key]);
    else config[f.key] = next[f.key];
  }
  const complete = isComplete(provider, next);
  await Integration.updateOne(
    { provider },
    { $set: { config, secrets, enabled: true, status: complete ? 'connected' : 'not_configured', updatedBy: user?.id, lastTestedAt: new Date(), ...(complete ? { lastError: null } : {}) } },
    { upsert: true }
  );
  invalidateCredentials(provider);
  await emitEvent('SETTINGS_CHANGED', {
    actorType: 'user', actor: user && { userId: user.id, name: user.name, role: user.role }, source: 'system',
    description: `${def.label} credentials updated`, metadata: { provider, fieldsChanged: Object.keys(input || {}).filter((k) => !secretKeys(provider).includes(k)) },
  });
  return getIntegrationView(provider);
}

export async function disconnectIntegration(provider, user) {
  if (!isProvider(provider)) throw ApiError.notFound('Unknown integration');
  await Integration.updateOne(
    { provider },
    { $set: { config: {}, secrets: {}, enabled: false, status: 'disconnected', updatedBy: user?.id } },
    { upsert: true }
  );
  invalidateCredentials(provider);
  await emitEvent('INTEGRATION_DISCONNECTED', {
    actorType: 'user', actor: user && { userId: user.id, name: user.name, role: user.role },
    source: 'system', description: `${PROVIDERS[provider].label} was disconnected`, data: { provider: PROVIDERS[provider].label },
  });
  return getIntegrationView(provider);
}

/** Re-enable a provider that was disconnected (falls back to env credentials if present). */
export async function enableIntegration(provider) {
  await Integration.updateOne({ provider }, { $set: { enabled: true, status: 'untested' } }, { upsert: true });
  invalidateCredentials(provider);
}
