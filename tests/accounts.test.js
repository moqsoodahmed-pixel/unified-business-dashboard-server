import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, clearCollections, as, request, mongoose, mockFetch, setCreds, sign } from './helpers/setup.js';

let app, tokens, admin, operator, root, mf;
const col = (n) => mongoose.connection.db.collection(n);
const mail = { to: ['buyer@example.com'], subject: 'Hello', htmlContent: '<p>Hi</p>' };

before(async () => { ({ app, tokens } = await bootstrap()); admin = as(app, tokens.ADMIN); operator = as(app, tokens.OPERATOR); root = as(app, tokens.SUPER_ADMIN); });
after(stopTestDb);
beforeEach(async () => { await clearCollections(); });
afterEach(() => mf?.restore());

const addAccount = (type, label, values) => root.post('/api/integrations/accounts', { type, label, values, force: true });

test('types endpoint describes the fields for the "Add account" form', async () => {
  const res = await admin.get('/api/integrations/types');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((t) => t.type), ['msg91', 'brevo', 'razorpay', 'telegram']);
  assert.ok(res.body.data.find((t) => t.type === 'brevo').fields.some((f) => f.key === 'apiKey' && f.secret && f.required));
});

test('an extra Brevo account can be added, gets its own webhook URL, and is listed without secrets', async () => {
  const res = await addAccount('brevo', 'Brevo — Marketing', { apiKey: 'xkeysib-third-account-key-000', senderEmail: 'news@company.test', senderName: 'News', webhookSecret: 'third-account-webhook-token' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const acc = res.body.data;
  assert.match(acc.provider, /^brevo_[a-z0-9]{4,16}$/);
  assert.equal(acc.type, 'brevo');
  assert.equal(acc.label, 'Brevo — Marketing');
  assert.equal(acc.builtin, false);
  assert.equal(acc.configured, true);
  assert.ok(acc.webhookUrl.endsWith(`/api/webhooks/brevo/${acc.provider}`));
  const list = await root.get('/api/integrations');
  assert.ok(list.body.data.some((i) => i.provider === acc.provider));
  assert.ok(!JSON.stringify(list.body).includes('xkeysib-third-account-key-000'));
  assert.ok(!JSON.stringify(list.body).includes('third-account-webhook-token'));
});

test('operators cannot add accounts', async () => {
  const res = await operator.post('/api/integrations/accounts', { type: 'brevo', values: { apiKey: 'xkeysib-aaaaaaaaaaaaaaaa' }, force: true });
  assert.equal(res.status, 403);
});

test('a failing credential test does not leave a half-created account behind', async () => {
  mf = mockFetch(() => ({ status: 401, json: { message: 'Key not found' } }));
  const res = await root.post('/api/integrations/accounts', { type: 'brevo', label: 'Bad', values: { apiKey: 'xkeysib-bad-key-000000000' } });
  assert.equal(res.status, 422);
  assert.equal(await col('integrations').countDocuments({ custom: true }), 0);
});

test('each account webhook is authenticated with that account\'s own token', async () => {
  const acc = (await addAccount('brevo', 'Third', { apiKey: 'xkeysib-third-account-key-000', webhookSecret: 'third-account-webhook-token' })).body.data;
  await setCreds('brevo', { apiKey: 'xkeysib-first-account-key-00', webhookSecret: 'first-account-webhook-token' });
  const post = (url, token) => request(app).post(url).set('Content-Type', 'application/json').set('Authorization', `Bearer ${token}`).send(JSON.stringify({ event: 'delivered', email: 'a@b.com', 'message-id': '<m1@x>', ts_event: 1 }));
  assert.equal((await post(`/api/webhooks/brevo/${acc.provider}`, 'third-account-webhook-token')).status, 200);
  assert.equal((await post(`/api/webhooks/brevo/${acc.provider}`, 'first-account-webhook-token')).status, 401);
  assert.equal((await post('/api/webhooks/brevo/brevo_doesnotexist', 'third-account-webhook-token')).status, 404);
  assert.ok(await col('webhookevents').findOne({ provider: acc.provider, status: { $ne: 'rejected' } }));
});

test('auto mode balances across all Brevo accounts and fails over when one is rejected', async () => {
  await setCreds('brevo', { apiKey: 'xkeysib-first-account-key-00', senderEmail: 'a1@company.test' });
  await setCreds('brevo2', { apiKey: 'xkeysib-second-account-key-0', senderEmail: 'a2@company.test' });
  const third = (await addAccount('brevo', 'Third', { apiKey: 'xkeysib-third-account-key-000', senderEmail: 'a3@company.test' })).body.data.provider;
  let n = 0;
  mf = mockFetch((c) => (c.url.endsWith('/smtp/email') ? { status: 201, json: { messageId: `<m${++n}@x>` } } : undefined));
  for (let i = 0; i < 6; i += 1) assert.equal((await admin.post('/api/email/send', mail)).status, 201);
  const counts = {};
  for (const e of await col('emails').find().toArray()) counts[e.brevoAccount] = (counts[e.brevoAccount] || 0) + 1;
  assert.deepEqual(counts, { brevo: 2, brevo2: 2, [third]: 2 }, 'each of the three accounts sent two emails');

  mf.restore();
  mf = mockFetch((c) => (c.url.endsWith('/smtp/email') ? (c.headers['api-key'] === 'xkeysib-first-account-key-00' ? { status: 402, json: { message: 'daily limit reached' } } : { status: 201, json: { messageId: `<f${++n}@x>` } }) : undefined));
  await col('emails').deleteMany({});
  const res = await admin.post('/api/email/send', mail);
  assert.equal(res.status, 201);
  assert.notEqual((await col('emails').findOne()).brevoAccount, 'brevo', 'the rejected account was skipped');
});

test('a specific Brevo account can be chosen by key; unknown keys are rejected', async () => {
  const third = (await addAccount('brevo', 'Third', { apiKey: 'xkeysib-third-account-key-000', senderEmail: 'a3@company.test' })).body.data.provider;
  mf = mockFetch((c) => (c.url.endsWith('/smtp/email') ? { status: 201, json: { messageId: '<k@x>' } } : undefined));
  const res = await admin.post('/api/email/send', { ...mail, account: third });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(mf.calls.find((c) => c.url.endsWith('/smtp/email')).headers['api-key'], 'xkeysib-third-account-key-000');
  assert.equal((await admin.post('/api/email/send', { ...mail, account: 'brevo_nothere1' })).status, 400);
  const accounts = await admin.get('/api/email/accounts');
  assert.ok(accounts.body.data.some((a) => a.key === third && a.configured));
});

test('Razorpay: an order created on a second account is verified and refunded with that account', async () => {
  await setCreds('razorpay', { keyId: 'rzp_test_FIRSTACCOUNT', keySecret: 'first-secret-123' });
  const second = (await addAccount('razorpay', 'Razorpay — Store 2', { keyId: 'rzp_test_SECONDACCOUNT', keySecret: 'second-secret-456', webhookSecret: 'second-webhook-secret' })).body.data.provider;
  const basic = (id, s) => `Basic ${Buffer.from(`${id}:${s}`).toString('base64')}`;
  mf = mockFetch((c) => {
    if (c.url.endsWith('/orders')) return { status: 200, json: { id: 'order_S2', amount: 50000, currency: 'INR', receipt: c.body.receipt, status: 'created' } };
    if (c.url.includes('/payments/pay_S2') && c.method === 'GET') return { status: 200, json: { id: 'pay_S2', order_id: 'order_S2', amount: 50000, currency: 'INR', status: 'captured', method: 'upi', created_at: 1 } };
    if (c.url.includes('/refund')) return { status: 200, json: { id: 'rfnd_S2', payment_id: 'pay_S2', amount: 50000, currency: 'INR', status: 'processed', created_at: 2 } };
    return undefined;
  });
  const order = await admin.post('/api/payments/orders', { amount: 500, account: second });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.data.checkout.keyId, 'rzp_test_SECONDACCOUNT');
  assert.equal(mf.calls.find((c) => c.url.endsWith('/orders')).headers.Authorization, basic('rzp_test_SECONDACCOUNT', 'second-secret-456'));
  assert.equal((await col('paymentorders').findOne({ orderId: 'order_S2' })).account, second);

  const signature = sign('second-secret-456', 'order_S2|pay_S2');
  const v = await admin.post('/api/payments/verify', { orderId: 'order_S2', paymentId: 'pay_S2', signature });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal((await col('payments').findOne({ paymentId: 'pay_S2' })).account, second);

  const pay = await col('payments').findOne({ paymentId: 'pay_S2' });
  const r = await admin.post(`/api/payments/${pay._id}/refund`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(mf.calls.find((c) => c.url.includes('/refund')).headers.Authorization, basic('rzp_test_SECONDACCOUNT', 'second-secret-456'));

  // the second account's webhook is signed with its own webhook secret
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_W2', amount: 1000, currency: 'INR', status: 'captured', method: 'card', created_at: 3 } } } });
  const hook = (secret) => request(app).post(`/api/webhooks/razorpay/${second}`).set('Content-Type', 'application/json').set('X-Razorpay-Signature', sign(secret, body)).set('X-Razorpay-Event-Id', `evt_${secret}`).send(body);
  assert.equal((await hook('wrong-secret')).status, 401);
  assert.equal((await hook('second-webhook-secret')).status, 200);
  assert.equal((await col('payments').findOne({ paymentId: 'pay_W2' })).account, second);
});

test('default account, rename and delete', async () => {
  const b = (await addAccount('razorpay', 'Store B', { keyId: 'rzp_test_STOREB', keySecret: 'storeb-secret-1' })).body.data.provider;
  const patched = await root.patch(`/api/integrations/${b}`, { label: 'Store B (main)', isDefault: true });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.label, 'Store B (main)');
  assert.equal(patched.body.data.isDefault, true);

  await setCreds('razorpay', { keyId: 'rzp_test_BUILTIN', keySecret: 'builtin-secret-1' });
  mf = mockFetch((c) => (c.url.endsWith('/orders') ? { status: 200, json: { id: 'order_D', amount: 10000, currency: 'INR', status: 'created' } } : undefined));
  const order = await admin.post('/api/payments/orders', { amount: 100 });
  assert.equal(order.body.data.checkout.keyId, 'rzp_test_STOREB', 'the default account is used when none is chosen');

  assert.equal((await root.delete('/api/integrations/razorpay')).status, 400, 'built-in accounts cannot be deleted');
  assert.equal((await root.delete(`/api/integrations/${b}`)).status, 200);
  assert.equal((await root.get(`/api/integrations/${b}`)).status, 404);
});

test('WhatsApp replies go out from the number the customer wrote to', async () => {
  const second = (await addAccount('msg91', 'Support line', { authKey: 'msg91-second-auth-key', integratedNumber: '919000000002', webhookSecret: 'second-msg91-webhook-token' })).body.data.provider;
  const inbound = { direction: 'inbound', customerNumber: '919812345678', integratedNumber: '919000000002', messageId: 'wamid.IN1', contentType: 'text', text: 'hello', ts: Math.floor(Date.now() / 1000) };
  const hook = await request(app).post(`/api/webhooks/msg91/${second}`).set('Content-Type', 'application/json').set('Authorization', 'Bearer second-msg91-webhook-token').send(JSON.stringify(inbound));
  assert.equal(hook.status, 200, JSON.stringify(hook.body));
  const conv = await col('whatsappconversations').findOne({});
  assert.ok(conv, JSON.stringify(hook.body));
  assert.equal(conv.account, second);

  mf = mockFetch(() => ({ status: 200, json: { status: 'success', request_id: 'req1' } }));
  const res = await admin.post('/api/whatsapp/messages', { conversationId: String(conv._id), type: 'text', text: 'Hi there' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(mf.calls[0].headers.authkey, 'msg91-second-auth-key');
  assert.equal((await col('whatsappmessages').findOne({ direction: 'out' })).account, second);
});

test('Telegram routes can use their own bot; unknown bots are rejected', async () => {
  const bot = (await addAccount('telegram', 'Alerts bot', { botToken: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc' })).body.data.provider;
  assert.equal((await admin.post('/api/telegram/routes', { name: 'X', chatId: '-1001', eventTypes: ['PAYMENT_*'], account: 'telegram_nothere1' })).status, 400);
  const route = await admin.post('/api/telegram/routes', { name: 'Payments', chatId: '-1002', eventTypes: ['PAYMENT_*'], account: bot });
  assert.equal(route.status, 201, JSON.stringify(route.body));
  mf = mockFetch((c) => (c.url.includes('/sendMessage') ? { status: 200, json: { ok: true, result: { message_id: 7 } } } : undefined));
  const t = await admin.post(`/api/telegram/routes/${route.body.data._id}/test`, {});
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(mf.calls[0].url.includes('bot123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abc/sendMessage'));
});

test('account pickers: users of a feature can list its accounts without secrets', async () => {
  await addAccount('msg91', 'Support line', { authKey: 'msg91-second-auth-key', integratedNumber: '919000000002' });
  const res = await operator.get('/api/integrations/accounts/msg91');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.some((a) => a.label === 'Support line' && a.configured && a.effectiveDefault));
  assert.ok(!JSON.stringify(res.body).includes('msg91-second-auth-key'));
  assert.equal((await operator.get('/api/integrations/accounts/telegram')).status, 403, 'operators cannot manage Telegram routes');
  assert.equal((await operator.get('/api/integrations')).status, 403);
});
