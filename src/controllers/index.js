import { ok, created } from '../utils/response.js';
import { ApiError } from '../utils/ApiError.js';
import { env, isProd } from '../config/env.js';
import { processorFor } from '../webhooks/processors.js';
import * as auth from '../services/auth.service.js';
import * as users from '../services/user.service.js';
import * as dashboard from '../services/dashboard.service.js';
import * as customers from '../services/customer.service.js';
import * as wa from '../services/msg91/whatsapp.service.js';
import * as inbox from '../services/msg91/inbox.service.js';
import * as email from '../services/brevo/email.service.js';
import * as pay from '../services/razorpay/payment.service.js';
import * as tg from '../services/telegram/telegram.service.js';
import * as activity from '../services/activity.service.js';
import * as reports from '../services/report.service.js';
import * as integrations from '../services/integration.service.js';
import * as webhooks from '../services/webhook.service.js';
import * as settings from '../services/settings.service.js';
import * as health from '../services/health.service.js';
import * as search from '../services/search.service.js';
import { EVENT_CATALOG } from '../constants/events.js';
import { listAccountDefs } from '../integrations/accounts.js';
import { apiBaseUrl } from '../config/env.js';

const ctxOf = (req) => ({ ip: req.ip, userAgent: req.headers['user-agent'] });
export const REFRESH_COOKIE = 'ubd_rt';
const cookieOpts = () => ({
  httpOnly: true, secure: isProd, sameSite: env.COOKIE_SAMESITE, path: '/api/auth', domain: env.COOKIE_DOMAIN,
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86400000,
});
const setRefresh = (res, token) => res.cookie(REFRESH_COOKIE, token, cookieOpts());
const clearRefresh = (res) => res.clearCookie(REFRESH_COOKIE, { ...cookieOpts(), maxAge: undefined });

/* ---------------- auth ---------------- */
export const authC = {
  async login(req, res) {
    const out = await auth.login(req.body, ctxOf(req));
    setRefresh(res, out.refreshToken);
    return ok(res, { accessToken: out.accessToken, user: out.user }, 'Signed in');
  },
  async refresh(req, res) {
    try {
      const out = await auth.refresh(req.cookies?.[REFRESH_COOKIE], ctxOf(req));
      setRefresh(res, out.refreshToken);
      return ok(res, { accessToken: out.accessToken, user: out.user }, 'Session refreshed');
    } catch (err) {
      if (err.errorCode !== 'REFRESH_RACE') clearRefresh(res);
      throw err;
    }
  },
  async logout(req, res) {
    await auth.logout(req.cookies?.[REFRESH_COOKIE], req.user, ctxOf(req));
    clearRefresh(res);
    return ok(res, null, 'Signed out');
  },
  me: (req, res) => ok(res, { user: { ...req.user } }),
  async changePassword(req, res) {
    await auth.changePassword(req.user.id, req.body, ctxOf(req));
    clearRefresh(res);
    return ok(res, null, 'Password changed. Please sign in again.');
  },
  sessions: async (req, res) => ok(res, await auth.listSessions(req.user.id, req.cookies?.[REFRESH_COOKIE])),
  async revokeSession(req, res) { await auth.revokeSession(req.user.id, req.params.id); return ok(res, null, 'Session revoked'); },
  async revokeOthers(req, res) { await auth.revokeAllSessions(req.user.id, req.cookies?.[REFRESH_COOKIE]); return ok(res, null, 'Other sessions revoked'); },
};

/* ---------------- users ---------------- */
export const userC = {
  list: async (_req, res) => ok(res, await users.listUsers()),
  create: async (req, res) => created(res, await users.createUser(req.body, req.user), 'User created'),
  update: async (req, res) => ok(res, await users.updateUser(req.params.id, req.body, req.user), 'User updated'),
  async resetPassword(req, res) { await users.resetPassword(req.params.id, req.body.newPassword, req.user); return ok(res, null, 'Password reset'); },
  unlock: async (req, res) => ok(res, await users.unlockUser(req.params.id, req.user), 'Account unlocked'),
};

/* ---------------- dashboard / search / activity / reports ---------------- */
export const dashboardC = { get: async (req, res) => ok(res, await dashboard.getDashboard(req.query, req.user)) };
export const searchC = { get: async (req, res) => ok(res, await search.globalSearch(req.query.q, req.user, { limit: Number(req.query.limit) || 5 })) };
export const activityC = { list: async (req, res) => ok(res, await activity.listActivity(req.query)) };
export const reportC = {
  list: (req, res) => ok(res, reports.listReports(req.user)),
  run: async (req, res) => ok(res, await reports.runReport(req.params.key, req.query, req.user)),
  async csv(req, res) {
    const { filename, csv } = await reports.reportCsv(req.params.key, req.query, req.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(csv);
  },
};

/* ---------------- customers ---------------- */
export const customerC = {
  list: async (req, res) => ok(res, await customers.listCustomers(req.query)),
  create: async (req, res) => created(res, await customers.createCustomer(req.body, req.user, req.ip), 'Customer created'),
  get: async (req, res) => ok(res, await customers.getCustomerProfile(req.params.id, { includePayments: req.user.permissions.includes('payments:read') })),
  update: async (req, res) => ok(res, await customers.updateCustomer(req.params.id, req.body, req.user, req.ip), 'Customer updated'),
  addNote: async (req, res) => created(res, await customers.addNote(req.params.id, req.body.text, req.user), 'Note added'),
  deleteNote: async (req, res) => ok(res, await customers.deleteNote(req.params.id, req.params.noteId), 'Note removed'),
  addTags: async (req, res) => ok(res, await customers.addTags(req.params.id, req.body.tags), 'Tags added'),
  removeTag: async (req, res) => ok(res, await customers.removeTag(req.params.id, req.params.tag), 'Tag removed'),
};

/* ---------------- whatsapp ---------------- */
export const waC = {
  conversations: async (req, res) => ok(res, await inbox.listConversations(req.query, req.user)),
  conversation: async (req, res) => ok(res, await inbox.getConversation(req.params.id)),
  messages: async (req, res) => ok(res, await inbox.listMessages(req.params.id, req.query)),
  read: async (req, res) => ok(res, await inbox.markRead(req.params.id)),
  unread: async (req, res) => ok(res, await inbox.markUnread(req.params.id)),
  archive: async (req, res) => ok(res, await inbox.archive(req.params.id), 'Conversation archived'),
  unarchive: async (req, res) => ok(res, await inbox.unarchive(req.params.id)),
  async patch(req, res) {
    let out;
    if (req.body.status) out = await inbox.setStatus(req.params.id, req.body.status);
    if (req.body.priority) out = await inbox.setPriority(req.params.id, req.body.priority);
    return ok(res, out ?? (await inbox.getConversation(req.params.id)), 'Conversation updated');
  },
  assign: async (req, res) => ok(res, await inbox.assign(req.params.id, req.body.userId), 'Assignment updated'),
  addTag: async (req, res) => ok(res, await inbox.addTag(req.params.id, req.body.tag)),
  removeTag: async (req, res) => ok(res, await inbox.removeTag(req.params.id, req.params.tag)),
  addNote: async (req, res) => ok(res, await inbox.addNote(req.params.id, req.body.text, req.user), 'Note added'),
  send: async (req, res) => created(res, await wa.sendMessage(req.body, req.user), 'Message sent'),
  templates: async (_req, res) => ok(res, await inbox.listTemplates()),
  createTemplate: async (req, res) => created(res, await inbox.createTemplate(req.body, req.user)),
  updateTemplate: async (req, res) => ok(res, await inbox.updateTemplate(req.params.id, req.body)),
  async deleteTemplate(req, res) { await inbox.deleteTemplate(req.params.id); return ok(res, null, 'Template deleted'); },
};

/* ---------------- email ---------------- */
export const emailC = {
  list: async (req, res) => ok(res, await email.listEmails(req.query)),
  get: async (req, res) => ok(res, await email.getEmail(req.params.id)),
  async stats(req, res) {
    const { resolveRange } = await import('../utils/dates.js');
    const r = resolveRange(req.query);
    return ok(res, await email.emailStats(r.from, r.to));
  },
  send: async (req, res) => created(res, await email.sendEmail(req.body, req.user), 'Email queued with Brevo'),
  templates: async (_req, res) => ok(res, await email.listTemplates()),
  createTemplate: async (req, res) => created(res, await email.createTemplate(req.body, req.user)),
  updateTemplate: async (req, res) => ok(res, await email.updateTemplate(req.params.id, req.body)),
  async deleteTemplate(req, res) { await email.deleteTemplate(req.params.id); return ok(res, null, 'Template deleted'); },
  remoteTemplates: async (req, res) => ok(res, await email.listRemoteTemplates(req.query.account)),
  accounts: async (_req, res) => ok(res, await email.listAccounts()),
  contacts: async (req, res) => ok(res, await email.listContacts(req.query)),
  updateContact: async (req, res) => ok(res, await email.updateContact(req.params.id, req.body)),
};

/* ---------------- payments ---------------- */
export const payC = {
  list: async (req, res) => ok(res, await pay.listPayments(req.query)),
  async stats(req, res) {
    const { resolveRange } = await import('../utils/dates.js');
    const r = resolveRange(req.query);
    return ok(res, await pay.paymentStats(r.from, r.to));
  },
  orders: async (req, res) => ok(res, await pay.listOrders(req.query)),
  refunds: async (req, res) => ok(res, await pay.listRefunds(req.query)),
  get: async (req, res) => ok(res, await pay.getPayment(req.params.id)),
  createOrder: async (req, res) => created(res, await pay.createOrder(req.body, req.user), 'Order created'),
  verify: async (req, res) => ok(res, await pay.verifyPayment(req.body, req.user), 'Payment verified'),
  refund: async (req, res) => created(res, await pay.refundPayment(req.params.id, req.body, req.user), 'Refund created'),
};

/* ---------------- telegram ---------------- */
export const tgC = {
  routes: async (_req, res) => ok(res, { routes: await tg.listRoutes(), presets: tg.ROUTE_PRESETS }),
  createRoute: async (req, res) => created(res, await tg.createRoute(req.body, req.user)),
  updateRoute: async (req, res) => ok(res, await tg.updateRoute(req.params.id, req.body)),
  async deleteRoute(req, res) { await tg.deleteRoute(req.params.id); return ok(res, null, 'Route deleted'); },
  testRoute: async (req, res) => ok(res, await tg.sendTestToRoute(req.params.id), 'Test message sent'),
  bot: async (req, res) => ok(res, await tg.getBotInfo(typeof req.query.account === 'string' && /^telegram(_[a-z0-9]{4,16})?$/.test(req.query.account) ? req.query.account : undefined)),
  discover: async (req, res) => ok(res, await tg.discoverChats(typeof req.query.account === 'string' && /^telegram(_[a-z0-9]{4,16})?$/.test(req.query.account) ? req.query.account : undefined)),
  notifications: async (req, res) => ok(res, await tg.listNotifications(req.query)),
};

/* ---------------- integrations ---------------- */
export const integrationC = {
  list: async (_req, res) => ok(res, await integrations.listIntegrations()),
  types: async (_req, res) => ok(res, integrations.listTypes()),
  accountOptions: async (req, res) => ok(res, await integrations.listAccountOptions(req.params.type)),
  createAccount: async (req, res) => created(res, await integrations.createAccount(req.body, req.user), 'Account added'),
  updateAccount: async (req, res) => ok(res, await integrations.updateAccount(req.params.provider, req.body, req.user), 'Account updated'),
  deleteAccount: async (req, res) => ok(res, await integrations.deleteAccount(req.params.provider, req.user), 'Account removed'),
  get: async (req, res) => ok(res, await integrations.getView(req.params.provider)),
  save: async (req, res) => ok(res, await integrations.saveIntegration(req.params.provider, req.body.values, { clear: req.body.clear, force: req.body.force }, req.user), 'Integration saved'),
  async test(req, res) {
    const result = await integrations.testConnection(req.params.provider);
    return ok(res, result, result.ok ? '✓ Connected successfully' : `✕ ${result.message}`);
  },
  disconnect: async (req, res) => ok(res, await integrations.disconnectIntegration(req.params.provider, req.user), 'Integration disconnected'),
  async connect(req, res) {
    await integrations.enableIntegration(req.params.provider);
    return ok(res, await integrations.getView(req.params.provider), 'Integration enabled');
  },
};

/* ---------------- webhook center ---------------- */
export const webhookC = {
  list: async (req, res) => ok(res, await webhooks.listWebhookEvents(req.query)),
  get: async (req, res) => ok(res, await webhooks.getWebhookEvent(req.params.id)),
  async retry(req, res) {
    try {
      const out = await webhooks.retryWebhookEvent(req.params.id, processorFor);
      return ok(res, { status: out.status, duplicate: out.duplicate }, 'Retry executed');
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw ApiError.unprocessable(`Retry failed: ${err.message}`, 'RETRY_FAILED');
    }
  },
  endpoints: async (_req, res) => ok(res, (await listAccountDefs()).filter((a) => a.webhookPath).map((a) => ({ provider: a.key, type: a.type, label: a.label, url: `${apiBaseUrl()}${a.webhookPath}` }))),
};

/* ---------------- settings ---------------- */
export const settingsC = {
  all: async (_req, res) => ok(res, await settings.getAllSections()),
  update: async (req, res) => ok(res, await settings.updateSection(req.params.section, req.body, req.user.id), 'Settings saved'),
  async notifications(_req, res) {
    const toggles = await settings.getNotificationToggles();
    const catalog = Object.entries(EVENT_CATALOG).filter(([, d]) => d.notify).map(([type, d]) => ({ type, label: d.label, category: d.category, severity: d.severity, enabled: toggles[type] }));
    return ok(res, { toggles, catalog });
  },
  updateNotifications: async (req, res) => ok(res, await settings.updateNotificationToggles(req.body, req.user.id), 'Notification preferences saved'),
};

/* ---------------- health ---------------- */
export const healthC = {
  pub: async (_req, res) => {
    const h = await health.getPublicHealth();
    return res.status(h.status === 'up' ? 200 : 503).json({ success: h.status === 'up', message: h.status, data: h });
  },
  detailed: async (_req, res) => ok(res, await health.getDetailedHealth()),
  probe: async (_req, res) => ok(res, await health.probeProviders(), 'Probe complete'),
};

export { ApiError };
