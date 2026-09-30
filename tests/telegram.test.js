import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, clearCollections, as, mongoose, mockFetch, setCreds } from './helpers/setup.js';

let app, tokens, admin, mf;
const BOT = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const col = (n) => mongoose.connection.db.collection(n);
const { emitEvent } = await import('../src/services/event.bus.js');

before(async () => { ({ app, tokens } = await bootstrap()); admin = as(app, tokens.ADMIN); });
after(stopTestDb);
beforeEach(async () => { await clearCollections(); });
afterEach(() => mf?.restore());

const tgOk = () => mockFetch(() => ({ json: { ok: true, result: { message_id: 77 } } }));
const sentTo = () => mf.calls.filter((c) => c.url.includes('/sendMessage')).map((c) => c.body);
const paymentEvent = (extra = {}) => ({ source: 'payment', description: 'ok', data: { customer: 'John Doe', amount: 2500000, currency: 'INR', orderId: 'order_xxxxx', paymentId: 'pay_xxxxx', method: 'UPI' }, ...extra });

test('without a bot token nothing is sent and the miss is recorded honestly', async () => {
  mf = tgOk();
  await admin.post('/api/telegram/routes', { name: 'Payments', chatId: '-100111', eventTypes: ['PAYMENT_*'] });
  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  assert.equal(sentTo().length, 0);
  assert.ok(await col('telegramevents').findOne({ outcome: 'not_configured' }));
});

test('route patterns are validated', async () => {
  const res = await admin.post('/api/telegram/routes', { name: 'Bad', chatId: '1', eventTypes: ['NOT_AN_EVENT'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, 'INVALID_EVENT_PATTERN');
});

test('events are routed only to matching destinations: payments → payments + admin, not WhatsApp/system', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = tgOk();
  for (const r of [
    { name: 'Payments', chatId: '-1001', eventTypes: ['PAYMENT_*'] },
    { name: 'WhatsApp', chatId: '-1002', eventTypes: ['WHATSAPP_*'] },
    { name: 'System', chatId: '-1003', eventTypes: ['SYSTEM_*', 'API_*'] },
    { name: 'Admin', chatId: '-1004', eventTypes: ['*'] },
  ]) assert.equal((await admin.post('/api/telegram/routes', r)).status, 201);

  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  const chats = sentTo().map((b) => b.chat_id).sort();
  assert.deepEqual(chats, ['-1001', '-1004']);
});

test('WhatsApp events reach the WhatsApp and admin chats only', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = tgOk();
  await admin.post('/api/telegram/routes', { name: 'Payments', chatId: '-1001', eventTypes: ['PAYMENT_*'] });
  await admin.post('/api/telegram/routes', { name: 'WhatsApp', chatId: '-1002', eventTypes: ['WHATSAPP_*'] });
  await admin.post('/api/telegram/routes', { name: 'Admin', chatId: '-1004', eventTypes: ['*'] });
  await emitEvent('WHATSAPP_RECEIVED', { source: 'whatsapp', description: 'x', data: { customer: 'Meera', phone: '919812345678', preview: 'Hi' } });
  assert.deepEqual(sentTo().map((b) => b.chat_id).sort(), ['-1002', '-1004']);
});

test('message format: structured, HTML-safe, no secrets, includes a dashboard link', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = tgOk();
  await admin.post('/api/telegram/routes', { name: 'Payments', chatId: '-1001', eventTypes: ['PAYMENT_*'] });
  await emitEvent('PAYMENT_SUCCESS', paymentEvent({ data: { customer: 'John <b>Doe</b>', amount: 2500000, currency: 'INR', orderId: 'order_xxxxx', paymentId: 'pay_xxxxx', method: 'UPI', apiKey: 'SHOULD-NOT-APPEAR', secret: BOT } }));
  const [msg] = sentTo();
  assert.match(msg.text, /PAYMENT SUCCESSFUL/);
  assert.match(msg.text, /₹25,000/);
  assert.match(msg.text, /order_xxxxx/);
  assert.match(msg.text, /pay_xxxxx/);
  assert.ok(!msg.text.includes('<b>Doe</b>'), 'user-supplied HTML is escaped');
  assert.ok(!msg.text.includes(BOT) && !msg.text.includes('SHOULD-NOT-APPEAR'));
  assert.equal(msg.parse_mode, 'HTML');
  assert.match(msg.text, /Dashboard/i);
});

test('per-event notification toggles are honoured', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = tgOk();
  await admin.post('/api/telegram/routes', { name: 'Admin', chatId: '-1004', eventTypes: ['*'] });
  const off = await admin.put('/api/settings/notifications', { PAYMENT_SUCCESS: false });
  assert.equal(off.status, 200);
  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  assert.equal(sentTo().length, 0);
  await admin.put('/api/settings/notifications', { PAYMENT_SUCCESS: true });
  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  assert.equal(sentTo().length, 1);
});

test('disabled routes receive nothing', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = tgOk();
  const r = await admin.post('/api/telegram/routes', { name: 'Admin', chatId: '-1004', eventTypes: ['*'], enabled: false });
  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  assert.equal(sentTo().length, 0);
  await admin.patch(`/api/telegram/routes/${r.body.data._id}`, { enabled: true });
  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  assert.equal(sentTo().length, 1);
});

test('Telegram delivery failures are logged, never thrown into the business flow', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = mockFetch(() => ({ status: 400, json: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } }));
  await admin.post('/api/telegram/routes', { name: 'Admin', chatId: '-1004', eventTypes: ['*'] });
  await emitEvent('PAYMENT_SUCCESS', paymentEvent());
  const n = await col('telegramnotifications').findOne({});
  assert.equal(n.status, 'failed');
  assert.match(n.error, /chat not found/);
  assert.ok(!JSON.stringify(n).includes(BOT));
  assert.ok(await col('activitylogs').findOne({ eventType: 'TELEGRAM_FAILED' }));
});

test('test-message endpoint delivers to one route', async () => {
  await setCreds('telegram', { botToken: BOT });
  mf = tgOk();
  const r = await admin.post('/api/telegram/routes', { name: 'Ops', chatId: '-1009', eventTypes: ['SYSTEM_*'] });
  const res = await admin.post(`/api/telegram/routes/${r.body.data._id}/test`, {});
  assert.equal(res.status, 200);
  assert.equal(sentTo()[0].chat_id, '-1009');
});

test('the bot token is never returned by the integrations API', async () => {
  await setCreds('telegram', { botToken: BOT });
  const res = await admin.get('/api/integrations');
  assert.ok(!JSON.stringify(res.body).includes(BOT));
  assert.equal(res.body.data.find((i) => i.provider === 'telegram').secretsConfigured.botToken, true);
});
