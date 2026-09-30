import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap, stopTestDb, request, as, mongoose } from './helpers/setup.js';

let app, tokens;
before(async () => { ({ app, tokens } = await bootstrap()); });
after(stopTestDb);

test('exactly three users are seeded, one per role', async () => {
  const n = await mongoose.connection.db.collection('users').countDocuments();
  assert.equal(n, 3);
});

test('passwords are stored hashed, never plain', async () => {
  const u = await mongoose.connection.db.collection('users').findOne({ role: 'ADMIN' });
  assert.match(u.passwordHash, /^\$2[aby]\$/);
  assert.notEqual(u.passwordHash, 'AdminPass123');
});

test('login returns access token and sets httpOnly refresh cookie; no token in body', async () => {
  const res = await request(app).post('/api/auth/login').send({ identifier: 'root@example.test', password: 'RootPass123' });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.accessToken);
  assert.equal(res.body.data.refreshToken, undefined);
  const cookie = res.headers['set-cookie'].find((c) => c.startsWith('ubd_rt='));
  assert.match(cookie, /HttpOnly/i);
});

test('wrong password gives a generic error, unknown user gives the same', async () => {
  const a = await request(app).post('/api/auth/login').send({ identifier: 'root@example.test', password: 'nope' });
  const b = await request(app).post('/api/auth/login').send({ identifier: 'ghost@example.test', password: 'nope' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.message, b.body.message);
  assert.equal(a.body.errorCode, 'INVALID_CREDENTIALS');
});

test('account locks after repeated failures, even with the right password afterwards', async () => {
  for (let i = 0; i < 3; i++) await request(app).post('/api/auth/login').send({ identifier: 'operator@example.test', password: 'bad' });
  const res = await request(app).post('/api/auth/login').send({ identifier: 'operator@example.test', password: 'OperatorPass123' });
  assert.equal(res.status, 423);
  assert.equal(res.body.errorCode, 'ACCOUNT_LOCKED');
  // unlock (super admin) so later tests can proceed
  const users = await as(app, tokens.SUPER_ADMIN).get('/api/users');
  const op = users.body.data.find((u) => u.role === 'OPERATOR');
  const unlock = await as(app, tokens.SUPER_ADMIN).post(`/api/users/${op.id}/unlock`, {});
  assert.equal(unlock.status, 200);
  const ok = await request(app).post('/api/auth/login').send({ identifier: 'operator@example.test', password: 'OperatorPass123' });
  assert.equal(ok.status, 200);
});

test('refresh rotates the token and reuse of the old token revokes the session family', async () => {
  const agent = request.agent(app);
  const login = await agent.post('/api/auth/login').send({ identifier: 'admin@example.test', password: 'AdminPass123' });
  const firstCookie = login.headers['set-cookie'].find((c) => c.startsWith('ubd_rt=')).split(';')[0];

  const r1 = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);
  assert.equal(r1.status, 200);
  const secondCookie = r1.headers['set-cookie'].find((c) => c.startsWith('ubd_rt=')).split(';')[0];
  assert.notEqual(firstCookie, secondCookie);

  await new Promise((r) => setTimeout(r, 10_500)); // outside the concurrent-refresh grace window
  const reuse = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.errorCode, 'REFRESH_REUSE');
  const after = await request(app).post('/api/auth/refresh').set('Cookie', secondCookie);
  assert.equal(after.status, 401, 'the newer token in the same family is revoked too');
});

test('protected routes reject missing and tampered tokens', async () => {
  assert.equal((await request(app).get('/api/dashboard')).status, 401);
  assert.equal((await request(app).get('/api/dashboard').set('Authorization', 'Bearer abc.def.ghi')).status, 401);
});

test('logout revokes the refresh session', async () => {
  const login = await request(app).post('/api/auth/login').send({ identifier: 'admin@example.test', password: 'AdminPass123' });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('ubd_rt=')).split(';')[0];
  const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).set('Authorization', `Bearer ${login.body.data.accessToken}`);
  assert.equal(out.status, 200);
  const r = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
  assert.equal(r.status, 401);
});

test('there is no public registration and the user cap is enforced', async () => {
  const reg = await request(app).post('/api/auth/register').send({ email: 'x@example.test', password: 'Passw0rdXyz' });
  assert.ok([401, 404].includes(reg.status), 'no registration endpoint exists');
  const res = await as(app, tokens.SUPER_ADMIN).post('/api/users', { name: 'X', email: 'x@example.test', username: 'xuser', password: 'Passw0rdXyz', role: 'ADMIN' });
  assert.equal(res.status, 409);
});

test('weak passwords are rejected on password change', async () => {
  const res = await as(app, tokens.ADMIN).post('/api/auth/change-password', { currentPassword: 'AdminPass123', newPassword: 'short' });
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, 'VALIDATION_ERROR');
});
