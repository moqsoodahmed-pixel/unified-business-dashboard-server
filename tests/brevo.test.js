import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, clearCollections, as, request, mongoose, mockFetch, setCreds } from './helpers/setup.js';

let app, tokens, admin, mf;
const TOKEN = 'brevo-webhook-token-1234567';
const col = (n) => mongoose.connection.db.collection(n);
const hook = (body, token = TOKEN) => request(app).post('/api/webhooks/brevo').set('Content-Type', 'application/json').set('Authorization', `Bearer ${token}`).send(JSON.stringify(body));

before(async () => { ({ app, tokens } = await bootstrap()); admin = as(app, tokens.ADMIN); });
after(stopTestDb);
beforeEach(async () => { await clearCollections(); });
afterEach(() => mf?.restore());

const configure = () => setCreds('brevo', { apiKey: 'xkeysib-0123456789abcdef', senderEmail: 'ops@company.test', senderName: 'Ops', webhookSecret: TOKEN });
const mail = { to: ['buyer@example.com'], subject: 'Invoice 42', htmlContent: '<p>Thanks</p>' };

test('without an API key sending fails with a clear not-configured error and stores nothing', async () => {
  const res = await admin.post('/api/email/send', mail);
  assert.equal(res.status, 409);
  assert.match(res.body.message, /not configured/i);
  assert.equal(await col('emails').countDocuments(), 0);
});

test('sends through Brevo /smtp/email with the api-key header and stores the message', async () => {
  await configure();
  mf = mockFetch(() => ({ status: 201, json: { messageId: '<abc.1@smtp-relay.test>' } }));
  const res = await admin.post('/api/email/send', { ...mail, cc: ['cc@example.com'] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'sent');
  const call = mf.calls.find((c) => c.url === 'https://api.brevo.com/v3/smtp/email');
  assert.ok(call);
  assert.equal(call.headers['api-key'], 'xkeysib-0123456789abcdef');
  assert.equal(call.body.sender.email, 'ops@company.test');
  assert.deepEqual(call.body.to, [{ email: 'buyer@example.com' }]);
  assert.ok(await col('activitylogs').findOne({ eventType: 'EMAIL_SENT' }));
  assert.ok(await col('customers').findOne({ email: 'buyer@example.com' }), 'recipient becomes a customer with source Email');
  const json = JSON.stringify(res.body);
  assert.ok(!json.includes('xkeysib-0123456789abcdef'));
});

test('a Brevo rejection is stored as failed and surfaced with a safe message', async () => {
  await configure();
  mf = mockFetch(() => ({ status: 400, json: { code: 'invalid_parameter', message: 'sender not validated' } }));
  const res = await admin.post('/api/email/send', mail);
  assert.ok(res.status >= 400);
  assert.match(res.body.message, /sender not validated/);
  assert.ok(!JSON.stringify(res.body).includes('xkeysib'));
  assert.equal((await col('emails').findOne({})).status, 'failed');
  assert.ok(await col('activitylogs').findOne({ eventType: 'EMAIL_FAILED' }));
});

test('composer validation: subject and content are required, recipients must be emails', async () => {
  await configure();
  assert.equal((await admin.post('/api/email/send', { to: ['x@y.com'], htmlContent: '<p>x</p>' })).status, 400);
  assert.equal((await admin.post('/api/email/send', { to: ['nope'], subject: 's', htmlContent: 'x' })).status, 400);
  assert.equal((await admin.post('/api/email/send', { to: ['x@y.com'], subject: 's' })).status, 400);
});

test('webhook events update status: delivered, opened, clicked; replays are not double counted', async () => {
  await configure();
  mf = mockFetch(() => ({ status: 201, json: { messageId: '<m-1@relay.test>' } }));
  await admin.post('/api/email/send', mail);
  const base = { 'message-id': '<m-1@relay.test>', email: 'buyer@example.com', ts_epoch: 1_800_000_000 };

  assert.equal((await hook({ ...base, event: 'delivered' })).status, 200);
  const open = { ...base, event: 'opened', ts_epoch: 1_800_000_060 };
  await hook(open);
  const replay = await hook(open);
  assert.equal(replay.body.data.duplicates, 1);
  await hook({ ...base, event: 'click', link: 'https://example.com/a', ts_epoch: 1_800_000_120 });

  const e = await col('emails').findOne({});
  assert.equal(e.delivered, true);
  assert.equal(e.opened, true);
  assert.equal(e.clicked, true);
  assert.equal(e.openCount, 1);
  assert.equal(e.clickCount, 1);
  assert.equal(e.status, 'clicked');
  assert.ok(await col('activitylogs').findOne({ eventType: 'EMAIL_DELIVERED' }));
});

test('a hard bounce blocks the address and later sends to it are refused', async () => {
  await configure();
  mf = mockFetch(() => ({ status: 201, json: { messageId: '<m-2@relay.test>' } }));
  await admin.post('/api/email/send', mail);
  await hook({ 'message-id': '<m-2@relay.test>', email: 'buyer@example.com', event: 'hard_bounce', reason: 'mailbox does not exist', ts_epoch: 1_800_000_010 });
  assert.ok(await col('activitylogs').findOne({ eventType: 'EMAIL_BOUNCED' }));
  assert.equal((await col('emailcontacts').findOne({ email: 'buyer@example.com' })).blocked, true);
  const again = await admin.post('/api/email/send', mail);
  assert.equal(again.status, 422);
  assert.equal(again.body.errorCode, 'RECIPIENT_BLOCKED');
});

test('webhook with a wrong token is rejected', async () => {
  await configure();
  const res = await hook({ event: 'delivered', email: 'a@b.com', 'message-id': '<x>' }, 'not-the-token-not-the-token');
  assert.equal(res.status, 401);
  assert.equal(await col('emailevents').countDocuments(), 0);
});

test('email stats and history endpoints', async () => {
  await configure();
  mf = mockFetch(() => ({ status: 201, json: { messageId: '<m-3@relay.test>' } }));
  await admin.post('/api/email/send', mail);
  const stats = await admin.get('/api/email/stats?range=today');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.data.sent >= 1 || stats.body.data.total >= 1, true, JSON.stringify(stats.body.data));
  const list = await admin.get('/api/email');
  assert.equal(list.body.data.items.length, 1);
});
