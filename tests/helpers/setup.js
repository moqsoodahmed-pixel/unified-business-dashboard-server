import './env.js';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';

const { connectDb, disconnectDb } = await import('../../src/config/db.js');
const { createApp } = await import('../../src/app.js');
const { seedUsers } = await import('../../src/scripts/seed.js');
const { registerDefaultHandlers } = await import('../../src/services/handlers.js');
const { clearHandlers, registerHandler } = await import('../../src/services/event.bus.js');
const { logActivity } = await import('../../src/services/activity.service.js');
const { notifyEvent } = await import('../../src/services/telegram/telegram.service.js');
const { invalidateCredentials } = await import('../../src/services/integration.credentials.js');
const { invalidateAccounts } = await import('../../src/integrations/accounts.js');

let memory = null;

export async function startTestDb() {
  let uri = process.env.TEST_MONGODB_URI;
  if (uri) {
    uri = uri.replace(/\/?$/, '/') + `ubd_test_${crypto.randomBytes(4).toString('hex')}`;
  } else {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    memory = await MongoMemoryServer.create();
    uri = memory.getUri('ubd_test');
  }
  await connectDb(uri);
  const { syncAllIndexes } = await import('./indexes.js');
  await syncAllIndexes();
  return uri;
}

export async function stopTestDb() {
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase().catch(() => {});
  await disconnectDb();
  if (memory) await memory.stop();
}

/** Reset data between tests but keep users so tokens stay valid. */
export async function clearCollections(except = ['users']) {
  const cols = await mongoose.connection.db.listCollections().toArray();
  for (const c of cols) if (!except.includes(c.name)) await mongoose.connection.db.collection(c.name).deleteMany({});
  invalidateCredentials();
  invalidateAccounts();
}

export function makeApp() {
  clearHandlers();
  registerDefaultHandlers();
  return createApp();
}

/** Sign in all three seeded roles; returns { app, tokens: { SUPER_ADMIN, ADMIN, OPERATOR } }. */
export async function bootstrap() {
  await startTestDb();
  await seedUsers();
  const app = makeApp();
  const tokens = {};
  const creds = { SUPER_ADMIN: ['root@example.test', 'RootPass123'], ADMIN: ['admin@example.test', 'AdminPass123'], OPERATOR: ['operator@example.test', 'OperatorPass123'] };
  for (const [role, [identifier, password]] of Object.entries(creds)) {
    const res = await request(app).post('/api/auth/login').send({ identifier, password });
    if (res.status !== 200) throw new Error(`login failed for ${role}: ${res.status} ${JSON.stringify(res.body)}`);
    tokens[role] = res.body.data.accessToken;
  }
  return { app, tokens };
}

export const as = (app, token) => ({
  get: (u) => request(app).get(u).set('Authorization', `Bearer ${token}`),
  post: (u, b) => request(app).post(u).set('Authorization', `Bearer ${token}`).send(b),
  put: (u, b) => request(app).put(u).set('Authorization', `Bearer ${token}`).send(b),
  patch: (u, b) => request(app).patch(u).set('Authorization', `Bearer ${token}`).send(b),
  delete: (u) => request(app).delete(u).set('Authorization', `Bearer ${token}`),
});

/** Replace global fetch for provider calls. handler(url, init) -> { status?, json? } | undefined (falls through to a 500). */
export function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body ? safeJson(init.body) : undefined };
    calls.push(call);
    const out = (await handler(call)) || { status: 500, json: { message: 'unmocked' } };
    const status = out.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => (out.json === undefined ? '' : JSON.stringify(out.json)) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const safeJson = (b) => { try { return JSON.parse(b); } catch { return b; } };

/** Save provider credentials directly (bypasses live validation) for tests. */
export async function setCreds(provider, values) {
  const { saveIntegration } = await import('../../src/services/integration.service.js');
  await saveIntegration(provider, values, { force: true }, { id: undefined, name: 'test', role: 'SUPER_ADMIN' });
  invalidateCredentials(provider);
}

export const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
export { request, mongoose };
export { registerHandler, logActivity, notifyEvent };
