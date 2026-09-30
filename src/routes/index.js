import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler as h } from '../utils/asyncHandler.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission as need, superAdminOnly } from '../middleware/rbac.js';
import { validate } from '../middleware/validate.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import * as C from '../controllers/index.js';
import * as V from '../validators/common.js';
import * as A from '../validators/auth.validators.js';

const wrap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, fn]) => [k, h(fn)]));
const { authC, userC, dashboardC, searchC, activityC, reportC, customerC, waC, emailC, payC, tgC, integrationC, webhookC, settingsC, healthC } = Object.fromEntries(
  Object.entries(C).filter(([k]) => k.endsWith('C')).map(([k, v]) => [k, wrap(v)])
);
const id = validate({ params: V.idParam });
const listQ = validate({ query: V.listQuery });

export function buildRouter() {
  const api = Router();

  /* ---- public ---- */
  api.get('/health', healthC.pub);
  const auth = Router();
  auth.post('/login', loginLimiter, validate({ body: A.loginBody }), authC.login);
  auth.post('/refresh', loginLimiter, authC.refresh);
  auth.post('/logout', h(async (req, res, next) => { try { await authenticate(req, res, () => {}); } catch { /* logout works with an expired access token */ } next(); }), authC.logout);
  auth.get('/me', authenticate, authC.me);
  auth.post('/change-password', authenticate, validate({ body: A.changePasswordBody }), authC.changePassword);
  auth.get('/sessions', authenticate, authC.sessions);
  auth.post('/sessions/revoke-others', authenticate, authC.revokeOthers);
  auth.delete('/sessions/:id', authenticate, id, authC.revokeSession);
  api.use('/auth', auth);

  /* ---- everything below requires a valid access token ---- */
  api.use(authenticate);

  api.get('/health/detailed', need('health:read'), healthC.detailed);
  api.post('/health/probe', need('health:read'), healthC.probe);
  api.get('/search', need('search:read'), validate({ query: z.object({ q: z.string().max(100).default(''), limit: z.coerce.number().int().min(1).max(10).optional() }) }), searchC.get);
  api.get('/dashboard', need('dashboard:read'), validate({ query: V.listQuery }), dashboardC.get);
  api.get('/activity', need('activity:read'), listQ, activityC.list);

  const users = Router();
  users.use(need('users:read'));
  users.get('/', userC.list);
  users.post('/', need('users:write'), validate({ body: A.userCreateBody }), userC.create);
  users.patch('/:id', need('users:write'), id, validate({ body: A.userUpdateBody }), userC.update);
  users.post('/:id/reset-password', need('users:write'), id, validate({ body: A.resetPasswordBody }), userC.resetPassword);
  users.post('/:id/unlock', need('users:write'), id, userC.unlock);
  api.use('/users', users);

  const customers = Router();
  customers.get('/', need('customers:read'), listQ, customerC.list);
  customers.post('/', need('customers:write'), validate({ body: V.customerCreate }), customerC.create);
  customers.get('/:id', need('customers:read'), id, customerC.get);
  customers.patch('/:id', need('customers:write'), id, validate({ body: V.customerUpdate }), customerC.update);
  customers.post('/:id/notes', need('customers:write'), id, validate({ body: V.noteBody }), customerC.addNote);
  customers.delete('/:id/notes/:noteId', need('customers:write'), validate({ params: z.object({ id: V.objectId, noteId: V.objectId }) }), customerC.deleteNote);
  customers.post('/:id/tags', need('customers:write'), id, validate({ body: V.tagsBody }), customerC.addTags);
  customers.delete('/:id/tags/:tag', need('customers:write'), validate({ params: z.object({ id: V.objectId, tag: z.string().min(1).max(40) }) }), customerC.removeTag);
  api.use('/customers', customers);

  const wa = Router();
  wa.get('/conversations', need('whatsapp:read'), listQ, waC.conversations);
  wa.get('/conversations/:id', need('whatsapp:read'), id, waC.conversation);
  wa.get('/conversations/:id/messages', need('whatsapp:read'), id, validate({ query: V.listQuery }), waC.messages);
  wa.post('/conversations/:id/read', need('whatsapp:write'), id, waC.read);
  wa.post('/conversations/:id/unread', need('whatsapp:write'), id, waC.unread);
  wa.post('/conversations/:id/archive', need('whatsapp:write'), id, waC.archive);
  wa.post('/conversations/:id/unarchive', need('whatsapp:write'), id, waC.unarchive);
  wa.patch('/conversations/:id', need('whatsapp:write'), id, validate({ body: V.convPatch }), waC.patch);
  wa.post('/conversations/:id/assign', need('whatsapp:write'), id, validate({ body: V.assignBody }), waC.assign);
  wa.post('/conversations/:id/tags', need('whatsapp:write'), id, validate({ body: V.tagBody }), waC.addTag);
  wa.delete('/conversations/:id/tags/:tag', need('whatsapp:write'), validate({ params: z.object({ id: V.objectId, tag: z.string().min(1).max(40) }) }), waC.removeTag);
  wa.post('/conversations/:id/notes', need('whatsapp:write'), id, validate({ body: V.noteBody }), waC.addNote);
  wa.post('/messages', need('whatsapp:write'), validate({ body: V.waSend }), waC.send);
  wa.get('/templates', need('whatsapp:read'), waC.templates);
  wa.post('/templates', need('whatsapp:write'), validate({ body: V.waTemplate }), waC.createTemplate);
  wa.patch('/templates/:id', need('whatsapp:write'), id, validate({ body: V.waTemplate.partial() }), waC.updateTemplate);
  wa.delete('/templates/:id', need('whatsapp:write'), id, waC.deleteTemplate);
  api.use('/whatsapp', wa);

  const email = Router();
  email.get('/', need('email:read'), listQ, emailC.list);
  email.get('/stats', need('email:read'), listQ, emailC.stats);
  email.post('/send', need('email:send'), validate({ body: V.emailSend }), emailC.send);
  email.get('/accounts', need('email:send'), emailC.accounts);
  email.get('/templates', need('email:read'), emailC.templates);
  email.get('/templates/remote', need('email:manage'), emailC.remoteTemplates);
  email.post('/templates', need('email:manage'), validate({ body: V.emailTemplate }), emailC.createTemplate);
  email.patch('/templates/:id', need('email:manage'), id, validate({ body: V.emailTemplatePatch }), emailC.updateTemplate);
  email.delete('/templates/:id', need('email:manage'), id, emailC.deleteTemplate);
  email.get('/contacts', need('email:read'), listQ, emailC.contacts);
  email.patch('/contacts/:id', need('email:manage'), id, validate({ body: V.emailContactPatch }), emailC.updateContact);
  email.get('/:id', need('email:read'), id, emailC.get);
  api.use('/email', email);

  const payments = Router();
  payments.get('/', need('payments:read'), listQ, payC.list);
  payments.get('/stats', need('payments:read'), listQ, payC.stats);
  payments.get('/orders', need('payments:read'), listQ, payC.orders);
  payments.get('/refunds', need('payments:read'), listQ, payC.refunds);
  payments.post('/orders', need('payments:write'), validate({ body: V.orderCreate }), payC.createOrder);
  payments.post('/verify', need('payments:write'), validate({ body: V.paymentVerify }), payC.verify);
  payments.get('/:id', need('payments:read'), payC.get);
  payments.post('/:id/refund', need('payments:refund'), validate({ body: V.refundBody }), payC.refund);
  api.use('/payments', payments);

  const telegram = Router();
  telegram.get('/routes', need('telegram:read'), tgC.routes);
  telegram.post('/routes', need('telegram:write'), validate({ body: V.routeCreate }), tgC.createRoute);
  telegram.patch('/routes/:id', need('telegram:write'), id, validate({ body: V.routePatch }), tgC.updateRoute);
  telegram.delete('/routes/:id', need('telegram:write'), id, tgC.deleteRoute);
  telegram.post('/routes/:id/test', need('telegram:write'), id, tgC.testRoute);
  telegram.get('/bot', need('telegram:read'), tgC.bot);
  telegram.get('/discover', need('telegram:write'), tgC.discover);
  telegram.get('/notifications', need('telegram:read'), listQ, tgC.notifications);
  api.use('/telegram', telegram);

  const reports = Router();
  reports.get('/', need('reports:read'), reportC.list);
  reports.get('/:key', need('reports:read'), validate({ query: V.listQuery }), reportC.run);
  reports.get('/:key/csv', need('reports:read'), validate({ query: V.listQuery }), reportC.csv);
  api.use('/reports', reports);

  const integrations = Router();
  integrations.get('/', need('integrations:read'), integrationC.list);
  integrations.get('/:provider', need('integrations:read'), validate({ params: V.providerParam }), integrationC.get);
  integrations.put('/:provider', need('integrations:write'), validate({ params: V.providerParam, body: V.integrationSave }), integrationC.save);
  integrations.post('/:provider/test', need('integrations:write'), validate({ params: V.providerParam }), integrationC.test);
  integrations.post('/:provider/disconnect', need('integrations:write'), validate({ params: V.providerParam }), integrationC.disconnect);
  integrations.post('/:provider/connect', need('integrations:write'), validate({ params: V.providerParam }), integrationC.connect);
  api.use('/integrations', integrations);

  const webhooks = Router();
  webhooks.get('/endpoints', need('webhooks:read'), webhookC.endpoints);
  webhooks.get('/', need('webhooks:read'), listQ, webhookC.list);
  webhooks.get('/:id', need('webhooks:read'), id, webhookC.get);
  webhooks.post('/:id/retry', need('webhooks:retry'), id, webhookC.retry);
  api.use('/webhooks', webhooks); // provider receivers are mounted before this router (see app.js)

  const settings = Router();
  settings.get('/', need('settings:read'), settingsC.all);
  settings.get('/notifications', need('notifications:read'), settingsC.notifications);
  settings.put('/notifications', need('notifications:write'), validate({ body: V.togglesBody }), settingsC.updateNotifications);
  settings.put('/:section', need('settings:write'), validate({ params: V.sectionParam }), settingsC.update);
  api.use('/settings', settings);

  return api;
}

export { superAdminOnly };
