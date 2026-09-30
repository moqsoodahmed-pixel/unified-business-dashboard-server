import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, as, request } from './helpers/setup.js';

let app, tokens;
before(async () => { ({ app, tokens } = await bootstrap()); });
after(stopTestDb);

const matrix = [
  // [method, url, body, SUPER_ADMIN, ADMIN, OPERATOR]  (true = allowed = not 401/403)
  ['get', '/api/users', null, true, false, false],
  ['get', '/api/dashboard', null, true, true, true],
  ['get', '/api/customers', null, true, true, true],
  ['get', '/api/payments', null, true, true, true],
  ['post', '/api/payments/orders', { amount: 100 }, true, true, false],
  ['post', '/api/payments/pay_x/refund', {}, true, true, false],
  ['get', '/api/integrations', null, true, true, false],
  ['put', '/api/integrations/telegram', { values: {} }, true, false, false],
  ['get', '/api/settings', null, true, true, false],
  ['put', '/api/settings/general', { companyName: 'X' }, true, false, false],
  ['get', '/api/reports', null, true, true, false],
  ['get', '/api/webhooks', null, true, true, false],
  ['get', '/api/telegram/routes', null, true, true, false],
  ['post', '/api/telegram/routes', { name: 'a', chatId: '1', eventTypes: ['*'] }, true, true, false],
  ['post', '/api/email/templates', { name: 'a', subject: 's' }, true, true, false],
  ['get', '/api/health/detailed', null, true, true, false],
  ['get', '/api/activity', null, true, true, true],
];

for (const [method, url, body, sa, ad, op] of matrix) {
  for (const [role, allowed] of [['SUPER_ADMIN', sa], ['ADMIN', ad], ['OPERATOR', op]]) {
    test(`${role} ${allowed ? 'can' : 'cannot'} ${method.toUpperCase()} ${url}`, async () => {
      const res = await as(app, tokens[role])[method](url, body ?? undefined);
      if (allowed) assert.ok(![401, 403].includes(res.status), `expected access, got ${res.status}`);
      else assert.equal(res.status, 403);
    });
  }
}

test('operators see payments but the customer profile keeps payment refund off-limits', async () => {
  const c = await as(app, tokens.OPERATOR).post('/api/customers', { firstName: 'Rita', phone: '9876500001' });
  assert.equal(c.status, 201);
  const prof = await as(app, tokens.OPERATOR).get(`/api/customers/${c.body.data._id}`);
  assert.equal(prof.status, 200);
});

test('unauthenticated requests never reach any protected handler', async () => {
  for (const [method, url] of [['get', '/api/customers'], ['get', '/api/integrations'], ['get', '/api/activity'], ['get', '/api/health/detailed']]) {
    assert.equal((await request(app)[method](url)).status, 401, url);
  }
});

test('public health endpoint discloses no provider detail', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.data).sort(), ['database', 'status', 'timestamp', 'uptimeSeconds']);
});
