import mongoose from 'mongoose';
import os from 'node:os';
import { dbState } from '../config/db.js';
import { listIntegrations } from './integration.service.js';
import { WebhookEvent } from '../models/index.js';
import { getCredentials } from './integration.credentials.js';
import { listAccountDefs } from '../integrations/accounts.js';
import { testers } from '../integrations/testers.js';
import { recordProviderResult } from './integration.service.js';
import { logger } from '../config/logger.js';

async function pingDb() {
  try {
    const t = Date.now();
    await mongoose.connection.db.admin().ping();
    return { ok: true, latencyMs: Date.now() - t };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

/** Minimal public probe for load balancers and uptime monitors: no provider detail is disclosed. */
export async function getPublicHealth() {
  const db = await pingDb();
  return { status: db.ok ? 'up' : 'down', database: db.ok ? 'up' : 'down', uptimeSeconds: Math.round(process.uptime()), timestamp: new Date().toISOString() };
}

export async function getDetailedHealth() {
  const [db, integrations, failedWebhooks] = await Promise.all([
    pingDb(), listIntegrations(),
    WebhookEvent.countDocuments({ status: 'failed', receivedAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) } }),
  ]);
  const providers = integrations.filter((i) => i.type).map((i) => ({
    provider: i.provider, type: i.type, label: i.label, status: i.status, configured: i.configured, lastSuccessAt: i.lastSuccessAt, lastErrorAt: i.lastErrorAt, lastError: i.lastError, lastTestedAt: i.lastTestedAt,
  }));
  const problems = providers.filter((p) => p.status === 'error').length + (db.ok ? 0 : 1);
  const mem = process.memoryUsage();
  return {
    status: !db.ok ? 'down' : problems ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    database: { state: dbState(), ok: db.ok, latencyMs: db.latencyMs, name: mongoose.connection.name },
    providers,
    webhooks: { failedLast24h: failedWebhooks },
    system: { node: process.version, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), loadAverage: os.loadavg().map((n) => +n.toFixed(2)), cpuCount: os.cpus().length },
  };
}

/** Background probe: refreshes provider status by running the read-only tester of each configured provider. */
export async function probeProviders() {
  const results = {};
  for (const { key: provider, type } of await listAccountDefs()) {
    const creds = await getCredentials(provider);
    if (!creds) continue;
    try {
      await testers[type](creds, provider);
      await recordProviderResult(provider, true, null, { tested: true });
      results[provider] = 'connected';
    } catch (err) {
      await recordProviderResult(provider, false, err.message, { tested: true });
      results[provider] = 'error';
      logger.warn({ provider }, 'provider health probe failed');
    }
  }
  return results;
}

