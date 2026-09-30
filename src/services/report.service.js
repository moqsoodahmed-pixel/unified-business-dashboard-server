import { isType } from '../integrations/registry.js';
import { Customer, WhatsAppMessage, Email, Payment, WebhookEvent, TelegramNotification } from '../models/index.js';
import { resolveRange, dayKey, enumerateDays, formatDateTime } from '../utils/dates.js';
import { toCsv } from '../utils/csv.js';
import { displayName } from './customer.service.js';
import { ApiError } from '../utils/ApiError.js';

const ROW_CAP = 20000;
const money = (minor) => Math.round(Number(minor || 0)) / 100;
const iso = (d) => (d ? new Date(d).toISOString() : '');
const col = (key, label) => ({ key, label });
const name = (c) => (c && typeof c === 'object' ? displayName(c) : '');
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : null);
const count = (rows, fn) => rows.reduce((m, r) => { const k = fn(r); m[k] = (m[k] || 0) + 1; return m; }, {});

/**
 * Report builders share one shape so the UI table, CSV export and a future PDF renderer all consume the same data:
 *   { key, title, generatedAt, filters, columns:[{key,label}], rows:[{...}], summary:{...}, truncated }
 */
const BUILDERS = {
  customers: {
    title: 'Customer report', permission: 'customers:read',
    async build(f) {
      const q = { createdAt: { $gte: f.from, $lt: f.to } };
      if (f.status) q.status = { $in: f.status };
      if (f.source) q.source = { $in: f.source };
      const docs = await Customer.find(q).sort({ createdAt: -1 }).limit(ROW_CAP + 1).lean();
      const rows = docs.slice(0, ROW_CAP).map((c) => ({
        name: name(c), phone: c.phone ? `+${c.phone}` : '', email: c.email || '', company: c.company || '', source: c.source, status: c.status,
        tags: (c.tags || []).join('; '), createdAt: iso(c.createdAt), lastInteractionAt: iso(c.lastInteractionAt),
      }));
      return {
        columns: [col('name', 'Name'), col('phone', 'Phone'), col('email', 'Email'), col('company', 'Company'), col('source', 'Source'), col('status', 'Status'), col('tags', 'Tags'), col('createdAt', 'Created'), col('lastInteractionAt', 'Last interaction')],
        rows, summary: { total: rows.length, bySource: count(rows, (r) => r.source), byStatus: count(rows, (r) => r.status) }, truncated: docs.length > ROW_CAP,
      };
    },
  },
  whatsapp: {
    title: 'WhatsApp report', permission: 'whatsapp:read',
    async build(f) {
      const q = { createdAt: { $gte: f.from, $lt: f.to } };
      if (f.customerId) q.customerId = f.customerId;
      if (f.status) q.status = { $in: f.status };
      const docs = await WhatsAppMessage.find(q).sort({ createdAt: -1 }).limit(ROW_CAP + 1).populate('customerId', 'firstName lastName').populate('sentBy', 'name').lean();
      const rows = docs.slice(0, ROW_CAP).map((m) => ({
        time: iso(m.createdAt), customer: name(m.customerId), phone: `+${m.phone}`, direction: m.direction === 'in' ? 'Inbound' : 'Outbound', type: m.type,
        status: m.status, message: (m.text || '').slice(0, 300), sentBy: m.sentBy?.name || '', error: m.error?.message || '',
      }));
      return {
        columns: [col('time', 'Time'), col('customer', 'Customer'), col('phone', 'Phone'), col('direction', 'Direction'), col('type', 'Type'), col('status', 'Status'), col('message', 'Message'), col('sentBy', 'Sent by'), col('error', 'Error')],
        rows, summary: { total: rows.length, inbound: rows.filter((r) => r.direction === 'Inbound').length, outbound: rows.filter((r) => r.direction === 'Outbound').length, byStatus: count(rows, (r) => r.status) }, truncated: docs.length > ROW_CAP,
      };
    },
  },
  email: {
    title: 'Email report', permission: 'email:read',
    async build(f) {
      const q = { createdAt: { $gte: f.from, $lt: f.to } };
      if (f.customerId) q.customerId = f.customerId;
      if (f.status) q.status = { $in: f.status };
      const docs = await Email.find(q).select('-htmlContent -textContent').sort({ createdAt: -1 }).limit(ROW_CAP + 1).populate('customerId', 'firstName lastName').populate('sentBy', 'name').lean();
      const rows = docs.slice(0, ROW_CAP).map((e) => ({
        time: iso(e.createdAt), to: e.to.map((t) => t.email).join('; '), customer: name(e.customerId), subject: e.subject, status: e.status,
        delivered: e.delivered ? 'Yes' : 'No', opened: e.opened ? 'Yes' : 'No', clicked: e.clicked ? 'Yes' : 'No', bounced: e.bounced ? 'Yes' : 'No', sentBy: e.sentBy?.name || '', error: e.error?.message || '',
      }));
      return {
        columns: [col('time', 'Time'), col('to', 'To'), col('customer', 'Customer'), col('subject', 'Subject'), col('status', 'Status'), col('delivered', 'Delivered'), col('opened', 'Opened'), col('clicked', 'Clicked'), col('bounced', 'Bounced'), col('sentBy', 'Sent by'), col('error', 'Error')],
        rows, summary: { total: rows.length, delivered: rows.filter((r) => r.delivered === 'Yes').length, opened: rows.filter((r) => r.opened === 'Yes').length, clicked: rows.filter((r) => r.clicked === 'Yes').length, bounced: rows.filter((r) => r.bounced === 'Yes').length, byStatus: count(rows, (r) => r.status) }, truncated: docs.length > ROW_CAP,
      };
    },
  },
  payments: {
    title: 'Payment report', permission: 'payments:read',
    async build(f) {
      const q = { razorpayCreatedAt: { $gte: f.from, $lt: f.to } };
      if (f.customerId) q.customerId = f.customerId;
      if (f.status) q.status = { $in: f.status };
      const docs = await Payment.find(q).sort({ razorpayCreatedAt: -1 }).limit(ROW_CAP + 1).populate('customerId', 'firstName lastName').lean();
      const rows = docs.slice(0, ROW_CAP).map((p) => ({
        createdAt: iso(p.razorpayCreatedAt), paymentId: p.paymentId, orderId: p.orderId || '', customer: name(p.customerId) || p.email || '', amount: money(p.amount),
        refunded: money(p.amountRefunded), currency: p.currency, status: p.status, method: p.method || '', error: p.errorDescription || '',
      }));
      const ok = rows.filter((r) => ['captured', 'partially_refunded', 'refunded'].includes(r.status));
      const gross = ok.reduce((s, r) => s + r.amount, 0);
      const refunded = ok.reduce((s, r) => s + r.refunded, 0);
      return {
        columns: [col('createdAt', 'Created'), col('paymentId', 'Payment ID'), col('orderId', 'Order ID'), col('customer', 'Customer'), col('amount', 'Amount'), col('refunded', 'Refunded'), col('currency', 'Currency'), col('status', 'Status'), col('method', 'Method'), col('error', 'Failure reason')],
        rows, summary: { total: rows.length, successful: ok.length, failed: rows.filter((r) => r.status === 'failed').length, gross: +gross.toFixed(2), refunded: +refunded.toFixed(2), net: +(gross - refunded).toFixed(2) }, truncated: docs.length > ROW_CAP,
      };
    },
  },
  revenue: {
    title: 'Revenue report', permission: 'payments:read',
    async build(f) {
      const docs = await Payment.find({ razorpayCreatedAt: { $gte: f.from, $lt: f.to }, status: { $in: ['captured', 'partially_refunded', 'refunded'] } }).select('razorpayCreatedAt amount amountRefunded method').limit(200000).lean();
      const days = enumerateDays(f);
      const map = new Map(days.map((d) => [d, { date: d, transactions: 0, gross: 0, refunded: 0, net: 0 }]));
      const byMethod = {};
      for (const p of docs) {
        const r = map.get(dayKey(p.razorpayCreatedAt));
        if (!r) continue;
        r.transactions += 1; r.gross += p.amount; r.refunded += p.amountRefunded || 0;
        byMethod[p.method || 'unknown'] = (byMethod[p.method || 'unknown'] || 0) + p.amount - (p.amountRefunded || 0);
      }
      const rows = [...map.values()].map((r) => ({ date: r.date, transactions: r.transactions, gross: money(r.gross), refunded: money(r.refunded), net: money(r.gross - r.refunded) }));
      const totals = rows.reduce((t, r) => ({ transactions: t.transactions + r.transactions, gross: t.gross + r.gross, refunded: t.refunded + r.refunded, net: t.net + r.net }), { transactions: 0, gross: 0, refunded: 0, net: 0 });
      return {
        columns: [col('date', 'Date'), col('transactions', 'Transactions'), col('gross', 'Gross'), col('refunded', 'Refunded'), col('net', 'Net')],
        rows, summary: { ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, +v.toFixed(2)])), averageValue: totals.transactions ? +(totals.gross / totals.transactions).toFixed(2) : 0, netByMethod: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, money(v)])) }, truncated: false,
      };
    },
  },
  integrations: {
    title: 'Integration report', permission: 'webhooks:read',
    async build(f) {
      const q = { receivedAt: { $gte: f.from, $lt: f.to }, status: { $ne: 'rejected' } };
      // A type (e.g. brevo) matches every account of that type (brevo, brevo2, brevo_<id>).
      if (f.provider) q.provider = { $in: f.provider.map((p) => (isType(p) ? new RegExp(`^${p}(2|_[a-z0-9]{4,16})?$`) : p)) };
      if (f.status) q.status = { $in: f.status };
      const [docs, rejected, tg] = await Promise.all([
        WebhookEvent.find(q).select('-payload').sort({ receivedAt: -1 }).limit(ROW_CAP + 1).lean(),
        WebhookEvent.countDocuments({ receivedAt: { $gte: f.from, $lt: f.to }, status: 'rejected' }),
        TelegramNotification.find({ createdAt: { $gte: f.from, $lt: f.to } }).select('status').lean(),
      ]);
      const rows = docs.slice(0, ROW_CAP).map((e) => ({
        receivedAt: iso(e.receivedAt), provider: e.provider, eventType: e.eventType || '', status: e.status, attempts: e.attempts, processingMs: e.processingMs ?? '', result: e.result || '', error: e.error || '',
      }));
      const byProvider = {};
      for (const r of rows) {
        const p = (byProvider[r.provider] ||= { total: 0, completed: 0, failed: 0, ignored: 0 });
        p.total += 1; if (r.status in p) p[r.status] += 1;
      }
      return {
        columns: [col('receivedAt', 'Received'), col('provider', 'Provider'), col('eventType', 'Event'), col('status', 'Status'), col('attempts', 'Attempts'), col('processingMs', 'Processing (ms)'), col('result', 'Result'), col('error', 'Error')],
        rows, summary: { total: rows.length, rejectedDeliveries: rejected, byProvider, telegramSent: tg.filter((t) => t.status === 'sent').length, telegramFailed: tg.filter((t) => t.status === 'failed').length }, truncated: docs.length > ROW_CAP,
      };
    },
  },
};

export const REPORT_KEYS = Object.keys(BUILDERS);
export const listReports = (user) => REPORT_KEYS.filter((k) => user.permissions.includes(BUILDERS[k].permission)).map((key) => ({ key, title: BUILDERS[key].title }));

export async function runReport(key, query, user) {
  const b = BUILDERS[key];
  if (!b) throw ApiError.notFound('Unknown report');
  if (!user.permissions.includes(b.permission)) throw ApiError.forbidden();
  const range = resolveRange(query);
  const filters = { from: range.from, to: range.to, range: range.range, customerId: query.customerId || undefined, status: list(query.status), provider: list(query.provider), source: list(query.source) };
  const body = await b.build(filters);
  return { key, title: b.title, generatedAt: new Date(), generatedAtLabel: formatDateTime(new Date()), filters: { ...filters, status: filters.status || undefined, provider: filters.provider || undefined, source: filters.source || undefined }, ...body };
}

export async function reportCsv(key, query, user) {
  const report = await runReport(key, query, user);
  return { filename: `${key}-report-${dayKey(new Date())}.csv`, csv: toCsv(report.rows, report.columns), report };
}
