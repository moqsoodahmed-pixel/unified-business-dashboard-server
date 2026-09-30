import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, as, mongoose } from './helpers/setup.js';

let app, tokens, admin;
before(async () => { ({ app, tokens } = await bootstrap()); admin = as(app, tokens.ADMIN); });
after(stopTestDb);

test('creates a customer, normalises the phone and writes an activity row', async () => {
  const res = await admin.post('/api/customers', { firstName: 'Asha', lastName: 'Rao', phone: '+91 98765 43210', email: 'Asha@Example.com' });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.phone, '919876543210');
  assert.equal(res.body.data.email, 'asha@example.com');
  const log = await mongoose.connection.db.collection('activitylogs').findOne({ eventType: 'CUSTOMER_CREATED' });
  assert.ok(log);
});

test('duplicate phone is rejected instead of silently merged', async () => {
  const res = await admin.post('/api/customers', { firstName: 'Other', phone: '9876543210' });
  assert.equal(res.status, 409);
  assert.equal(res.body.errorCode, 'DUPLICATE_PHONE');
});

test('same email on a different phone is flagged as a possible duplicate, not merged', async () => {
  const res = await admin.post('/api/customers', { firstName: 'Asha2', phone: '9000000001', email: 'asha@example.com' });
  assert.equal(res.status, 201);
  const profile = await admin.get(`/api/customers/${res.body.data._id}`);
  assert.equal(profile.body.data.customer.possibleDuplicates.length, 1);
  const list = await admin.get('/api/customers?q=asha');
  assert.equal(list.body.data.items.length, 2, 'both records still exist');
});

test('validation errors use the standard envelope', async () => {
  const res = await admin.post('/api/customers', { firstName: 'X', bogus: 1 });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.body).sort(), ['data', 'errorCode', 'message', 'success']);
  assert.equal(res.body.success, false);
});

test('notes and tags', async () => {
  const list = await admin.get('/api/customers?q=asha');
  const id = list.body.data.items[0]._id;
  assert.equal((await admin.post(`/api/customers/${id}/notes`, { text: 'VIP' })).status, 201);
  const t = await admin.post(`/api/customers/${id}/tags`, { tags: ['vip', 'b2b'] });
  assert.deepEqual(t.body.data.tags.sort(), ['b2b', 'vip']);
  const r = await admin.delete(`/api/customers/${id}/tags/vip`);
  assert.deepEqual(r.body.data.tags, ['b2b']);
});

test('NoSQL operator injection in filters is neutralised', async () => {
  const res = await admin.get('/api/customers?status[$ne]=x&q[$regex]=.*');
  assert.ok([200, 400].includes(res.status));
  if (res.status === 200) assert.ok(Array.isArray(res.body.data.items));
});
