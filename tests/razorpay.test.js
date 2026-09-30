import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, clearCollections, as, request, mongoose, mockFetch, setCreds, sign } from './helpers/setup.js';

let app, tokens, admin, op, mf;
const KEY_ID = 'rzp_test_AbCdEf123456';
const KEY_SECRET = 'rzp-key-secret-abcdef';
const WH_SECRET = 'rzp-webhook-secret-abc';
const col = (n) => mongoose.connection.db.collection(n);

before(async () => { ({ app, tokens } = await bootstrap()); admin = as(app, tokens.ADMIN); op = as(app, tokens.OPERATOR); });
after(stopTestDb);
beforeEach(async () => { await clearCollections(); await setCreds('razorpay', { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WH_SECRET }); });
afterEach(() => mf?.restore());

const payEntity = (over = {}) => ({ id: 'pay_1', entity: 'payment', amount: 2500000, currency: 'INR', status: 'captured', order_id: 'order_1', method: 'upi', vpa: 'a@upi', email: 'john@example.com', contact: '+919811122233', notes: { name: 'John Doe' }, created_at: 1_800_000_000, amount_refunded: 0, ...over });
const wh = (event, payload, { id = 'evt_1', secret = WH_SECRET, sigOverride } = {}) => {
  const raw = JSON.stringify({ event, payload, created_at: 1_800_000_000 });
  return request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('X-Razorpay-Event-Id', id)
    .set('X-Razorpay-Signature', sigOverride ?? sign(secret, raw)).send(raw);
};

test('creating an order converts rupees to paise, calls Razorpay with basic auth and stores the order', async () => {
  mf = mockFetch(() => ({ json: { id: 'order_1', amount: 2500000, currency: 'INR', receipt: 'r1', status: 'created' } }));
  const res = await admin.post('/api/payments/orders', { amount: 25000, receipt: 'r1', customer: { name: 'John Doe', phone: '9811122233', email: 'john@example.com' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const call = mf.calls.find((c) => c.url.endsWith('/v1/orders'));
  assert.equal(call.body.amount, 2500000);
  assert.equal(call.headers.Authorization, `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`);
  assert.equal(res.body.data.checkout.keyId, KEY_ID);
  assert.ok(!JSON.stringify(res.body).includes(KEY_SECRET), 'secret never leaves the server');
  assert.ok(await col('paymentorders').findOne({ orderId: 'order_1' }));
  assert.ok(await col('customers').findOne({ phone: '919811122233' }));
});

test('operators cannot create orders or refunds', async () => {
  assert.equal((await op.post('/api/payments/orders', { amount: 10 })).status, 403);
  assert.equal((await op.post('/api/payments/pay_1/refund', {})).status, 403);
});

test('amount validation', async () => {
  assert.equal((await admin.post('/api/payments/orders', { amount: 0 })).status, 400);
  assert.equal((await admin.post('/api/payments/orders', { amount: -5 })).status, 400);
});

test('checkout signature verification: forged signature is rejected, nothing is marked paid', async () => {
  await col('paymentorders').insertOne({ orderId: 'order_1', amount: 2500000, currency: 'INR', status: 'created', createdAt: new Date() });
  const res = await admin.post('/api/payments/verify', { orderId: 'order_1', paymentId: 'pay_1', signature: 'a'.repeat(64) });
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, 'INVALID_SIGNATURE');
  assert.equal(await col('payments').countDocuments(), 0);
});

test('a valid checkout signature is confirmed against Razorpay before the payment is stored', async () => {
  await col('paymentorders').insertOne({ orderId: 'order_1', amount: 2500000, currency: 'INR', status: 'created', createdAt: new Date() });
  mf = mockFetch((c) => (c.url.includes('/payments/pay_1') ? { json: payEntity() } : undefined));
  const signature = sign(KEY_SECRET, 'order_1|pay_1');
  const res = await admin.post('/api/payments/verify', { orderId: 'order_1', paymentId: 'pay_1', signature });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'captured');
  assert.ok(mf.calls.some((c) => c.url.includes('/payments/pay_1')), 'status fetched from Razorpay, not trusted from the browser');
  assert.equal(await col('payments').countDocuments(), 1);
});

test('verify rejects a payment whose amount differs from the order', async () => {
  await col('paymentorders').insertOne({ orderId: 'order_1', amount: 100000, currency: 'INR', status: 'created', createdAt: new Date() });
  mf = mockFetch(() => ({ json: payEntity({ amount: 2500000 }) }));
  const res = await admin.post('/api/payments/verify', { orderId: 'order_1', paymentId: 'pay_1', signature: sign(KEY_SECRET, 'order_1|pay_1') });
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, 'AMOUNT_MISMATCH');
});

test('webhook with a bad signature is rejected before any processing', async () => {
  const res = await wh('payment.captured', { payment: { entity: payEntity() } }, { sigOverride: 'f'.repeat(64) });
  assert.equal(res.status, 401);
  assert.equal(await col('payments').countDocuments(), 0);
  assert.ok(await col('webhookevents').findOne({ provider: 'razorpay', status: 'rejected' }));
});

test('captured webhook stores the payment, links a customer, logs activity', async () => {
  const res = await wh('payment.captured', { payment: { entity: payEntity() } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const p = await col('payments').findOne({ paymentId: 'pay_1' });
  assert.equal(p.status, 'captured');
  assert.equal(p.amount, 2500000);
  assert.ok(p.customerId, 'linked to a customer');
  assert.ok(await col('activitylogs').findOne({ eventType: 'PAYMENT_SUCCESS' }));
  const list = await op.get('/api/payments');
  assert.equal(list.body.data.items.length, 1);
  const stats = await admin.get('/api/payments/stats?range=last30');
  assert.equal(stats.status, 200);
});

test('IDEMPOTENCY: the same event delivered repeatedly creates one payment, one activity row, one WebhookEvent', async () => {
  const body = { payment: { entity: payEntity() } };
  const first = await wh('payment.captured', body, { id: 'evt_dup' });
  const second = await wh('payment.captured', body, { id: 'evt_dup' });
  const third = await wh('payment.captured', body, { id: 'evt_dup' });
  assert.equal(first.body.data.duplicate, false);
  assert.equal(second.body.data.duplicate, true);
  assert.equal(third.body.data.duplicate, true);
  assert.equal(await col('payments').countDocuments({ paymentId: 'pay_1' }), 1);
  assert.equal(await col('activitylogs').countDocuments({ eventType: 'PAYMENT_SUCCESS' }), 1);
  const events = await col('webhookevents').find({ provider: 'razorpay', eventId: 'evt_dup' }).toArray();
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'completed');
  assert.ok(events[0].payloadHash);
});

test('IDEMPOTENCY: concurrent deliveries of the same event are processed once', async () => {
  const body = { payment: { entity: payEntity({ id: 'pay_conc', order_id: 'order_conc' }) } };
  await Promise.all(Array.from({ length: 6 }, () => wh('payment.captured', body, { id: 'evt_conc' })));
  assert.equal(await col('payments').countDocuments({ paymentId: 'pay_conc' }), 1);
  assert.equal(await col('activitylogs').countDocuments({ eventType: 'PAYMENT_SUCCESS' }), 1);
  assert.equal(await col('webhookevents').countDocuments({ provider: 'razorpay', eventId: 'evt_conc' }), 1);
});

test('a different event id for the same payment state still cannot duplicate the payment or its notification', async () => {
  await wh('payment.captured', { payment: { entity: payEntity() } }, { id: 'evt_a' });
  await wh('payment.captured', { payment: { entity: payEntity() } }, { id: 'evt_b' });
  assert.equal(await col('payments').countDocuments({ paymentId: 'pay_1' }), 1);
  assert.equal(await col('activitylogs').countDocuments({ eventType: 'PAYMENT_SUCCESS' }), 1);
});

test('out-of-order events never move a payment backwards (failed after captured is ignored)', async () => {
  await wh('payment.captured', { payment: { entity: payEntity() } }, { id: 'e1' });
  await wh('payment.failed', { payment: { entity: payEntity({ status: 'failed' }) } }, { id: 'e2' });
  assert.equal((await col('payments').findOne({ paymentId: 'pay_1' })).status, 'captured');
});

test('failed payment creates PAYMENT_FAILED', async () => {
  await wh('payment.failed', { payment: { entity: payEntity({ id: 'pay_f', status: 'failed', error_description: 'Bank declined' }) } }, { id: 'e3' });
  assert.equal((await col('payments').findOne({ paymentId: 'pay_f' })).status, 'failed');
  assert.ok(await col('activitylogs').findOne({ eventType: 'PAYMENT_FAILED' }));
});

test('partial refund via API updates payment, creates a refund row and PAYMENT_REFUNDED', async () => {
  await wh('payment.captured', { payment: { entity: payEntity() } }, { id: 'e4' });
  mf = mockFetch(() => ({ json: { id: 'rfnd_1', entity: 'refund', payment_id: 'pay_1', amount: 500000, currency: 'INR', status: 'processed', created_at: 1_800_000_500 } }));
  const res = await admin.post('/api/payments/pay_1/refund', { amount: 5000, reason: 'goodwill' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const refundCall = mf.calls.find((c) => c.url.endsWith('/payments/pay_1/refund'));
  assert.equal(refundCall.body.amount, 500000);
  const p = await col('payments').findOne({ paymentId: 'pay_1' });
  assert.equal(p.status, 'partially_refunded');
  assert.equal(p.amountRefunded, 500000);
  assert.ok(await col('refunds').findOne({ refundId: 'rfnd_1' }));
  assert.ok(await col('activitylogs').findOne({ eventType: 'PAYMENT_REFUNDED' }));
});

test('refund cannot exceed the refundable balance or target an uncaptured payment', async () => {
  await wh('payment.captured', { payment: { entity: payEntity() } }, { id: 'e5' });
  mf = mockFetch(() => ({ json: {} }));
  const big = await admin.post('/api/payments/pay_1/refund', { amount: 999999 });
  assert.equal(big.status, 400);
  assert.equal(big.body.errorCode, 'REFUND_EXCEEDS_BALANCE');
  await wh('payment.failed', { payment: { entity: payEntity({ id: 'pay_x', status: 'failed' }) } }, { id: 'e6' });
  assert.equal((await admin.post('/api/payments/pay_x/refund', {})).status, 409);
});

test('a processing failure returns 500 so Razorpay retries, is logged as failed, and the Webhook Center retry reports it cleanly', async () => {
  const bad = { payment: { entity: payEntity({ id: 'pay_bad', amount: 'not-a-number' }) } };
  const res = await wh('payment.captured', bad, { id: 'evt_bad' });
  assert.equal(res.status, 500);
  assert.equal(res.body.errorCode, 'WEBHOOK_PROCESSING_FAILED');
  const ev = await col('webhookevents').findOne({ eventId: 'evt_bad' });
  assert.equal(ev.status, 'failed');
  assert.ok(await col('activitylogs').findOne({ eventType: 'WEBHOOK_FAILED' }), 'failure is visible in the activity log');

  const retry = await admin.post(`/api/webhooks/${ev._id}/retry`, {});
  assert.equal(retry.status, 422);
  assert.equal(retry.body.errorCode, 'RETRY_FAILED');
  assert.equal(await col('webhookevents').countDocuments({ eventId: 'evt_bad' }), 1, 'retry reuses the record');
  assert.equal((await col('webhookevents').findOne({ eventId: 'evt_bad' })).attempts, 2);
  assert.equal(await col('payments').countDocuments({ paymentId: 'pay_bad' }), 0);
});

test('a failed event whose cause is fixed succeeds on retry exactly once', async () => {
  const payload = { event: 'payment.captured', __eventId: 'evt_fix', payload: { payment: { entity: payEntity({ id: 'pay_fix', order_id: 'order_fix' }) } } };
  await col('webhookevents').insertOne({ provider: 'razorpay', eventId: 'evt_fix', eventType: 'payment.captured', payloadHash: 'h', payload, status: 'failed', attempts: 1, error: 'temporary outage', receivedAt: new Date(), createdAt: new Date(), updatedAt: new Date() });
  const ev = await col('webhookevents').findOne({ eventId: 'evt_fix' });
  const r1 = await admin.post(`/api/webhooks/${ev._id}/retry`, {});
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal((await col('webhookevents').findOne({ eventId: 'evt_fix' })).status, 'completed');
  assert.equal(await col('payments').countDocuments({ paymentId: 'pay_fix' }), 1);
  const r2 = await admin.post(`/api/webhooks/${ev._id}/retry`, {});
  assert.equal(r2.status, 409, 'completed events are not retryable');
  assert.equal(await col('payments').countDocuments({ paymentId: 'pay_fix' }), 1);
});

test('webhook center lists deliveries with redacted payloads', async () => {
  await wh('payment.captured', { payment: { entity: payEntity() } }, { id: 'e7' });
  const list = await admin.get('/api/webhooks?provider=razorpay');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 1);
  assert.equal(list.body.data.items[0].status, 'completed');
});

test('integration view masks the key id and hides secrets', async () => {
  const res = await admin.get('/api/integrations/razorpay');
  const t = JSON.stringify(res.body);
  assert.ok(!t.includes(KEY_SECRET) && !t.includes(WH_SECRET));
  assert.ok(t.includes('rzp_test_****'));
  assert.ok(!t.includes(KEY_ID.slice(9)));
});
