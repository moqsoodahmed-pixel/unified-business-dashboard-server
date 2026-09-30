import { Customer, WhatsAppMessage, WhatsAppConversation, Email, Payment, TelegramNotification, WebhookEvent, ActivityLog } from '../models/index.js';
import { resolveRange, startOfDay, addDays, dayKey, enumerateDays } from '../utils/dates.js';
import { emailStats } from './brevo/email.service.js';
import { paymentStats } from './razorpay/payment.service.js';
import { listIntegrations } from './integration.service.js';

const SERIES_CAP = 100000;
const has = (user, perm) => user.permissions.includes(perm);

/** Build [{ date, ...fields }] with a zeroed row per day, filled by `add(row, doc)`. */
function bucket(days, docs, dateField, zero, add) {
  const map = new Map(days.map((d) => [d, { date: d, ...zero() }]));
  for (const doc of docs) {
    const row = map.get(dayKey(doc[dateField]));
    if (row) add(row, doc);
  }
  return [...map.values()];
}

/**
 * Everything the home dashboard shows, in one call. Sections the caller may not see are omitted (null),
 * so the same endpoint safely serves every role.
 */
export async function getDashboard(query, user) {
  const now = new Date();
  const range = resolveRange(query, now);
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const days = enumerateDays(range);
  const out = { range: { from: range.from, to: range.to, range: range.range }, generatedAt: now };

  const jobs = {};

  jobs.customers = has(user, 'customers:read') && (async () => {
    const [total, newToday, recent] = await Promise.all([
      Customer.countDocuments({}),
      Customer.countDocuments({ createdAt: { $gte: today, $lt: tomorrow } }),
      Customer.find({ createdAt: { $gte: range.from, $lt: range.to } }).select('createdAt').limit(SERIES_CAP).lean(),
    ]);
    const before = total - recent.length;
    let running = Math.max(0, before);
    const growth = bucket(days, recent, 'createdAt', () => ({ newCustomers: 0 }), (r) => { r.newCustomers += 1; })
      .map((r) => { running += r.newCustomers; return { ...r, total: running }; });
    return { total, newToday, newInRange: recent.length, growth };
  })();

  jobs.whatsapp = has(user, 'whatsapp:read') && (async () => {
    const [messagesToday, unreadConversations, msgs, recentConversations] = await Promise.all([
      WhatsAppMessage.countDocuments({ createdAt: { $gte: today, $lt: tomorrow } }),
      WhatsAppConversation.countDocuments({ status: { $ne: 'archived' }, $or: [{ unreadCount: { $gt: 0 } }, { markedUnread: true }] }),
      WhatsAppMessage.find({ createdAt: { $gte: range.from, $lt: range.to } }).select('createdAt direction status').limit(SERIES_CAP).lean(),
      WhatsAppConversation.find({ status: { $ne: 'archived' } }).sort({ lastMessageAt: -1 }).limit(8).populate('customerId', 'firstName lastName phone').lean(),
    ]);
    const series = bucket(days, msgs, 'createdAt', () => ({ inbound: 0, outbound: 0, failed: 0 }), (r, m) => {
      if (m.direction === 'in') r.inbound += 1; else r.outbound += 1;
      if (m.status === 'failed') r.failed += 1;
    });
    const unreadMessages = await WhatsAppConversation.find({ status: { $ne: 'archived' }, unreadCount: { $gt: 0 } }).select('unreadCount').lean();
    return {
      messagesToday, unreadConversations, unreadMessages: unreadMessages.reduce((s, c) => s + c.unreadCount, 0),
      inRange: msgs.length, series, recentConversations,
    };
  })();

  jobs.email = has(user, 'email:read') && (async () => {
    const [todayStats, rangeStats, rows] = await Promise.all([
      emailStats(today, tomorrow), emailStats(range.from, range.to),
      Email.find({ createdAt: { $gte: range.from, $lt: range.to } }).select('createdAt status delivered opened clicked bounced').limit(SERIES_CAP).lean(),
    ]);
    const series = bucket(days, rows, 'createdAt', () => ({ sent: 0, delivered: 0, opened: 0, failed: 0 }), (r, e) => {
      if (e.status !== 'queued') r.sent += 1;
      if (e.delivered) r.delivered += 1;
      if (e.opened) r.opened += 1;
      if (e.status === 'failed' || e.bounced) r.failed += 1;
    });
    return { sentToday: todayStats.sent, today: todayStats, range: rangeStats, series };
  })();

  jobs.payments = has(user, 'payments:read') && (async () => {
    const [todayStats, rangeStats, rows, recent] = await Promise.all([
      paymentStats(today, tomorrow), paymentStats(range.from, range.to),
      Payment.find({ razorpayCreatedAt: { $gte: range.from, $lt: range.to } }).select('razorpayCreatedAt amount amountRefunded status').limit(SERIES_CAP).lean(),
      Payment.find({}).sort({ razorpayCreatedAt: -1 }).limit(8).populate('customerId', 'firstName lastName').lean(),
    ]);
    const series = bucket(days, rows, 'razorpayCreatedAt', () => ({ revenue: 0, successful: 0, failed: 0 }), (r, p) => {
      if (['captured', 'partially_refunded', 'refunded'].includes(p.status)) { r.revenue += p.amount - (p.amountRefunded || 0); r.successful += 1; }
      else if (p.status === 'failed') r.failed += 1;
    });
    return { today: todayStats, range: rangeStats, series, recent, currency: rangeStats.currency };
  })();

  jobs.telegram = has(user, 'telegram:read') && (async () => {
    const [sent, failed] = await Promise.all([
      TelegramNotification.countDocuments({ status: 'sent', createdAt: { $gte: range.from, $lt: range.to } }),
      TelegramNotification.countDocuments({ status: 'failed', createdAt: { $gte: range.from, $lt: range.to } }),
    ]);
    return { sent, failed };
  })();

  jobs.integrationActivity = has(user, 'webhooks:read') && (async () => {
    const [hooks, tg] = await Promise.all([
      WebhookEvent.find({ receivedAt: { $gte: range.from, $lt: range.to }, status: { $ne: 'rejected' } }).select('provider status receivedAt').limit(SERIES_CAP).lean(),
      TelegramNotification.find({ createdAt: { $gte: range.from, $lt: range.to } }).select('createdAt').limit(SERIES_CAP).lean(),
    ]);
    const a = bucket(days, hooks, 'receivedAt', () => ({ msg91: 0, brevo: 0, brevo2: 0, razorpay: 0, telegram: 0, failed: 0 }), (r, h) => {
      r[h.provider] = (r[h.provider] || 0) + 1;
      if (h.status === 'failed') r.failed += 1;
    });
    const map = new Map(a.map((r) => [r.date, r]));
    for (const t of tg) { const r = map.get(dayKey(t.createdAt)); if (r) r.telegram += 1; }
    return a;
  })();

  jobs.health = has(user, 'health:read') && listIntegrations().then((list) => list.map((i) => ({ provider: i.provider, label: i.label, status: i.status, lastError: i.lastError })));

  jobs.recentActivity = has(user, 'activity:read') &&
    ActivityLog.find({}).sort({ createdAt: -1 }).limit(10).populate('customerId', 'firstName lastName').lean();

  const keys = Object.keys(jobs);
  const values = await Promise.all(keys.map((k) => Promise.resolve(jobs[k] || null)));
  keys.forEach((k, i) => { out[k] = values[i]; });
  return out;
}
