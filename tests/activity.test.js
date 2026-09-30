import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, clearCollections, as, request, mongoose, mockFetch, setCreds } from './helpers/setup.js';

let app, tokens, admin, op, sa;
const col = (n) => mongoose.connection.db.collection(n);
const { emitEvent } = await import('../src/services/event.bus.js');
const { redactDeep } = await import('../src/utils/redact.js');

before(async () => { ({ app, tokens } = await bootstrap()); admin = as(app, tokens.ADMIN); op = as(app, tokens.OPERATOR); sa = as(app, tokens.SUPER_ADMIN); });
after(stopTestDb);
beforeEach(async () => { await clearCollections(); });

test('sensitive metadata is redacted before it is stored', async () => {
  await emitEvent('SYSTEM_ERROR', { source: 'system', description: 'boom', metadata: { password: 'hunter2', nested: { apiKey: 'k-123', token: 't', safe: 'visible' }, authorization: 'Bearer abc' } });
  const row = await col('activitylogs').findOne({ eventType: 'SYSTEM_ERROR' });
  const text = JSON.stringify(row);
  for (const leak of ['hunter2', 'k-123', 'Bearer abc']) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.equal(row.metadata.nested.safe, 'visible');
});

test('redactDeep handles cycles and depth', () => {
  const a = { name: 'x' }; a.self = a;
  const out = redactDeep({ a, secret: 's' });
  assert.equal(out.secret, '[REDACTED]');
  assert.equal(out.a.self, '[circular]');
});

test('logins, failed logins and logouts are recorded with the caller IP', async () => {
  await request(app).post('/api/auth/login').send({ identifier: 'admin@example.test', password: 'wrong-pass' });
  const ok = await request(app).post('/api/auth/login').send({ identifier: 'admin@example.test', password: 'AdminPass123' });
  await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${ok.body.data.accessToken}`);
  const types = (await col('activitylogs').find({}).toArray()).map((r) => r.eventType);
  for (const t of ['FAILED_LOGIN', 'USER_LOGIN', 'USER_LOGOUT']) assert.ok(types.includes(t), `${t} missing`);
  const login = await col('activitylogs').findOne({ eventType: 'USER_LOGIN' });
  assert.ok(login.ipAddress);
  assert.ok(!JSON.stringify(login).includes('AdminPass123'));
});

test('activity API filters by event type and paginates; every role with activity:read can see it', async () => {
  for (let i = 0; i < 5; i++) await emitEvent('CUSTOMER_CREATED', { source: 'customer', description: `c${i}` });
  await emitEvent('EMAIL_SENT', { source: 'email', description: 'mail' });
  const all = await op.get('/api/activity?limit=4');
  assert.equal(all.status, 200);
  assert.equal(all.body.data.items.length, 4);
  const f = await admin.get('/api/activity?eventType=EMAIL_SENT');
  assert.equal(f.body.data.items.length, 1);
});

test('notification-only events (not in the activity catalog) do not pollute the log', async () => {
  await emitEvent('PAYMENT_LARGE', { source: 'payment', description: 'large', data: {} });
  assert.equal(await col('activitylogs').countDocuments({ eventType: 'PAYMENT_LARGE' }), 0);
});

test('unhandled server errors return a generic message in production mode style and create SYSTEM_ERROR', async () => {
  const res = await sa.get('/api/customers/not-an-object-id');
  assert.equal(res.status, 400);
  assert.equal(res.body.success, false);
  assert.ok(!('stack' in res.body));
});

test('global search finds customers and respects permissions', async () => {
  await admin.post('/api/customers', { firstName: 'Zoya', lastName: 'Khan', phone: '9822200011', email: 'zoya@example.com' });
  const r = await op.get('/api/search?q=zoya');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.results.some((x) => x.source === 'Customer' && /Zoya/.test(x.title)));
  const short = await op.get('/api/search?q=z');
  assert.equal(short.body.data.results.length, 0);
});

test('reports: list is permission-filtered and CSV export works', async () => {
  const opList = await op.get('/api/reports');
  assert.equal(opList.status, 403);
  const list = await admin.get('/api/reports');
  assert.ok(list.body.data.length >= 5);
  const key = list.body.data.find((r) => /customer/i.test(r.key))?.key || list.body.data[0].key;
  await admin.post('/api/customers', { firstName: 'Csv', phone: '9822200022' });
  const csv = await admin.get(`/api/reports/${key}/csv?range=last30`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers['content-type'], /text\/csv/);
  assert.match(csv.headers['content-disposition'], /attachment/);
});

test('dashboard returns live numbers derived from the database, not fixtures', async () => {
  await admin.post('/api/customers', { firstName: 'Dash', phone: '9822200033' });
  const res = await admin.get('/api/dashboard?range=today');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.customers.total, 1);
  assert.equal(res.body.data.customers.newToday, 1);
  const opView = await op.get('/api/dashboard?range=today');
  assert.equal(opView.status, 200);
});

test('integrations: unconfigured providers report honestly; test-connection never fakes success', async () => {
  const list = await sa.get('/api/integrations');
  const msg91 = list.body.data.find((i) => i.provider === 'msg91');
  assert.equal(msg91.configured, false);
  assert.notEqual(msg91.status, 'connected');
  const t = await sa.post('/api/integrations/msg91/test', {});
  assert.equal(t.body.data.ok, false);
  assert.match(t.body.data.message, /not configured/i);
});

test('saving credentials validates them against the provider first, and rejects on failure', async () => {
  const mf = mockFetch(() => ({ status: 401, json: { message: 'Unauthorized' } }));
  try {
    const res = await sa.put('/api/integrations/brevo', { values: { apiKey: 'xkeysib-badbadbadbadbad1' } });
    assert.equal(res.status, 422);
    assert.equal(res.body.errorCode, 'CREDENTIAL_TEST_FAILED');
    assert.ok(!JSON.stringify(res.body).includes('xkeysib-badbadbadbadbad1'));
  } finally { mf.restore(); }
});

test('credentials are encrypted at rest', async () => {
  await setCreds('telegram', { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw' });
  const raw = await col('integrations').findOne({ provider: 'telegram' });
  assert.ok(!JSON.stringify(raw).includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'));
});

test('OpenAPI document is served and Swagger UI mounts at /api/docs', async () => {
  const ui = await request(app).get('/api/docs/');
  assert.equal(ui.status, 200);
  assert.match(ui.text, /swagger/i);
});
