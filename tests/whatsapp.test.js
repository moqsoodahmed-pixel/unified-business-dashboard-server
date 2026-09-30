import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, clearCollections, as, request, mongoose, mockFetch, setCreds } from './helpers/setup.js';

let app, tokens, op, admin, mf;
const SECRET = 'msg91-webhook-secret-123456';
const col = (n) => mongoose.connection.db.collection(n);
const hook = (body, secret = SECRET) => request(app).post('/api/webhooks/msg91').set('Content-Type', 'application/json').set('X-Webhook-Secret', secret).send(JSON.stringify(body));

before(async () => { ({ app, tokens } = await bootstrap()); op = as(app, tokens.OPERATOR); admin = as(app, tokens.ADMIN); });
after(stopTestDb);
beforeEach(async () => { await clearCollections(); });
afterEach(() => mf?.restore());

async function configure() {
  await setCreds('msg91', { authKey: 'auth-key-abcdefgh', integratedNumber: '919999999999', webhookSecret: SECRET });
}
const inbound = (over = {}) => ({ direction: 0, customerNumber: '919812345678', uuid: 'wamid-1', profileName: 'Meera', contentType: 'text', content: JSON.stringify({ type: 'text', text: { body: 'Hello there' } }), ...over });

test('webhook without credentials is rejected and logged, never processed', async () => {
  await configure();
  const bad = await hook(inbound(), 'wrong-secret-wrong-secret');
  assert.equal(bad.status, 401);
  assert.equal(await col('whatsappmessages').countDocuments(), 0);
  assert.ok(await col('webhookevents').findOne({ provider: 'msg91', status: 'rejected' }));
});

test('webhook is refused when no webhook secret is configured', async () => {
  const res = await hook(inbound());
  assert.equal(res.status, 503);
  assert.equal(res.body.errorCode, 'WEBHOOK_SECRET_MISSING');
});

test('inbound message creates customer, conversation, message, activity and appears in the inbox API', async () => {
  await configure();
  const res = await hook(inbound());
  assert.equal(res.status, 200);
  assert.equal(res.body.data.processed, 1);

  const customer = await col('customers').findOne({ phone: '919812345678' });
  assert.ok(customer, 'customer created from WhatsApp');
  assert.equal(customer.source, 'WhatsApp');
  const conv = await col('whatsappconversations').findOne({ phone: '919812345678' });
  assert.equal(conv.unreadCount, 1);
  assert.equal(conv.messageCount, 1);
  assert.ok(await col('activitylogs').findOne({ eventType: 'WHATSAPP_RECEIVED' }));

  const list = await op.get('/api/whatsapp/conversations');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 1);
  const msgs = await op.get(`/api/whatsapp/conversations/${list.body.data.items[0]._id}/messages`);
  assert.equal(msgs.body.data.items[0].text, 'Hello there');
});

test('the same delivery, repeated, is stored once (idempotent)', async () => {
  await configure();
  await hook(inbound());
  const again = await hook(inbound());
  assert.equal(again.status, 200);
  assert.equal(again.body.data.duplicates, 1);
  assert.equal(await col('whatsappmessages').countDocuments(), 1);
  assert.equal((await col('whatsappconversations').findOne({})).unreadCount, 1);
});

test('mark read / unread, archive, tag, note, assign', async () => {
  await configure();
  await hook(inbound());
  const id = String((await col('whatsappconversations').findOne({}))._id);
  assert.equal((await op.post(`/api/whatsapp/conversations/${id}/read`, {})).body.data.unreadCount, 0);
  assert.equal((await op.post(`/api/whatsapp/conversations/${id}/unread`, {})).body.data.markedUnread, true);
  assert.equal((await op.post(`/api/whatsapp/conversations/${id}/tags`, { tag: 'vip' })).body.data.tags[0], 'vip');
  assert.equal((await op.post(`/api/whatsapp/conversations/${id}/notes`, { text: 'call back' })).body.data.notes.length, 1);
  assert.equal((await op.post(`/api/whatsapp/conversations/${id}/archive`, {})).body.data.status, 'archived');
  const me = (await op.get('/api/auth/me')).body.data.user.id;
  const asg = (await op.post(`/api/whatsapp/conversations/${id}/assign`, { userId: me })).body.data.assignedTo;
  assert.equal(String(asg?._id ?? asg), me);
});

test('delivery status webhooks advance the message and never move it backwards', async () => {
  await configure();
  mf = mockFetch(() => ({ json: { status: 'success', request_id: 'req-9', message_uuid: 'wamid-out-1' } }));
  await hook(inbound());
  const send = await op.post('/api/whatsapp/messages', { phone: '919812345678', type: 'text', text: 'Hi Meera' });
  assert.equal(send.status, 201, JSON.stringify(send.body));
  assert.equal(send.body.data.status, 'sent');

  const uuid = send.body.data.providerMessageId;
  if (uuid) {
    await hook({ direction: 1, customerNumber: '919812345678', uuid, status: 'read', ts: 1_800_000_100 });
    await hook({ direction: 1, customerNumber: '919812345678', uuid, status: 'delivered', ts: 1_800_000_050 });
    const m = await col('whatsappmessages').findOne({ providerMessageId: uuid });
    assert.equal(m.status, 'read');
  }
});

test('sending calls MSG91 with the stored auth key and records the message', async () => {
  await configure();
  mf = mockFetch(() => ({ json: { status: 'success', request_id: 'req-1' } }));
  await hook(inbound());
  const res = await op.post('/api/whatsapp/messages', { phone: '919812345678', type: 'text', text: 'Thanks for writing' });
  assert.equal(res.status, 201);
  const call = mf.calls.find((c) => c.url.includes('msg91.com'));
  assert.ok(call, 'MSG91 was called');
  assert.match(call.url, /whatsapp-outbound-message/);
  assert.equal(JSON.stringify(call.headers).includes('auth-key-abcdefgh'), true, 'auth key is sent to MSG91');
  const u = new URL(call.url);
  assert.equal(u.searchParams.get('recipient_number'), '919812345678');
  assert.equal(u.searchParams.get('text'), 'Thanks for writing');
  assert.ok(await col('activitylogs').findOne({ eventType: 'WHATSAPP_SENT' }));
});

test('free-form text outside the 24h window is blocked; templates are allowed', async () => {
  await configure();
  mf = mockFetch(() => ({ json: { status: 'success', request_id: 'req-2' } }));
  const blocked = await op.post('/api/whatsapp/messages', { phone: '919700000001', type: 'text', text: 'hello?' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.errorCode, 'OUTSIDE_SESSION_WINDOW');
  const tpl = await op.post('/api/whatsapp/messages', { phone: '919700000001', type: 'template', template: { name: 'order_update', language: 'en', variables: ['A1'] } });
  assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
});

test('provider failure is stored as failed, reported honestly and creates a failure event', async () => {
  await configure();
  mf = mockFetch((c) => (c.url.includes('outbound') ? { status: 400, json: { message: 'Invalid template' } } : undefined));
  await hook(inbound());
  const res = await op.post('/api/whatsapp/messages', { phone: '919812345678', type: 'text', text: 'x' });
  assert.ok(res.status >= 400);
  assert.match(res.body.message, /Invalid template/);
  const m = await col('whatsappmessages').findOne({ direction: 'out' });
  assert.equal(m.status, 'failed');
  assert.ok(await col('activitylogs').findOne({ eventType: 'WHATSAPP_FAILED' }));
});

test('without credentials the API says so and creates nothing', async () => {
  const res = await op.post('/api/whatsapp/messages', { phone: '919812345678', type: 'text', text: 'x' });
  assert.equal(res.status, 409);
  assert.equal(res.body.errorCode, 'NOT_CONFIGURED');
  assert.match(res.body.message, /not configured/i);
  assert.equal(await col('whatsappmessages').countDocuments(), 0);
});

test('integration listing never returns secrets', async () => {
  await configure();
  const res = await admin.get('/api/integrations');
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('auth-key-abcdefgh'));
  assert.ok(!text.includes(SECRET));
  const msg91 = res.body.data.find((i) => i.provider === 'msg91');
  assert.equal(msg91.secretsConfigured.authKey, true);
});
