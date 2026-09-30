import { env } from '../../config/env.js';
import { EVENT_CATALOG } from '../../constants/events.js';
import { formatDateTime } from '../../utils/dates.js';
import { scrubSecrets } from '../../utils/redact.js';

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n = 300) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

export function formatMoney(paise, currency = 'INR') {
  const major = Number(paise) / 100;
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: Number.isInteger(major) ? 0 : 2, maximumFractionDigits: 2 }).format(major);
  } catch {
    return `${currency} ${major}`;
  }
}

// [label, key in event.data] per event. Only whitelisted keys are ever printed.
const FIELDS = {
  WHATSAPP_RECEIVED: [['Customer', 'customer'], ['Phone', 'phone'], ['Message', 'preview']],
  WHATSAPP_SENT: [['Customer', 'customer'], ['Phone', 'phone'], ['Message', 'preview'], ['Sent by', 'sentBy']],
  WHATSAPP_DELIVERED: [['Customer', 'customer'], ['Phone', 'phone']],
  WHATSAPP_READ: [['Customer', 'customer'], ['Phone', 'phone']],
  WHATSAPP_FAILED: [['Customer', 'customer'], ['Phone', 'phone'], ['Reason', 'reason']],
  EMAIL_SENT: [['To', 'to'], ['Subject', 'subject'], ['Sent by', 'sentBy']],
  EMAIL_DELIVERED: [['To', 'to'], ['Subject', 'subject']],
  EMAIL_FAILED: [['To', 'to'], ['Subject', 'subject'], ['Reason', 'reason']],
  EMAIL_BOUNCED: [['To', 'to'], ['Subject', 'subject'], ['Reason', 'reason']],
  PAYMENT_CREATED: [['Customer', 'customer'], ['Amount', '$amount'], ['Order ID', 'orderId']],
  PAYMENT_SUCCESS: [['Customer', 'customer'], ['Amount', '$amount'], ['Order ID', 'orderId'], ['Payment ID', 'paymentId'], ['Method', 'method']],
  PAYMENT_FAILED: [['Customer', 'customer'], ['Amount', '$amount'], ['Order ID', 'orderId'], ['Payment ID', 'paymentId'], ['Method', 'method'], ['Reason', 'reason']],
  PAYMENT_REFUNDED: [['Customer', 'customer'], ['Refund', '$amount'], ['Payment ID', 'paymentId'], ['Refund ID', 'refundId']],
  PAYMENT_LARGE: [['Customer', 'customer'], ['Amount', '$amount'], ['Payment ID', 'paymentId'], ['Method', 'method']],
  PAYMENT_WEBHOOK_FAILED: [['Event', 'eventType'], ['Event ID', 'eventId'], ['Error', 'error']],
  CUSTOMER_CREATED: [['Name', 'name'], ['Phone', 'phone'], ['Email', 'email'], ['Source', 'source']],
  CUSTOMER_UPDATED: [['Name', 'name'], ['Fields', 'fields']],
  USER_LOGIN: [['User', 'user'], ['Role', 'role'], ['IP', 'ip']],
  FAILED_LOGIN: [['User', 'user'], ['Reason', 'reason'], ['IP', 'ip']],
  ACCOUNT_LOCKED: [['User', 'user'], ['Locked for', 'minutes']],
  PASSWORD_CHANGED: [['User', 'user'], ['IP', 'ip']],
  SESSION_REUSE_DETECTED: [['User', 'user'], ['IP', 'ip']],
  WEBHOOK_FAILED: [['Provider', 'provider'], ['Event', 'eventType'], ['Error', 'error']],
  SYSTEM_ERROR: [['Where', 'where'], ['Error', 'error']],
  DATABASE_ERROR: [['Error', 'error']],
  API_FAILURE: [['Provider', 'provider'], ['Error', 'error']],
  INTEGRATION_DISCONNECTED: [['Integration', 'provider']],
  HIGH_ERROR_RATE: [['Errors (5 min)', 'count']],
};

const STATUS = {
  PAYMENT_SUCCESS: 'SUCCESS', PAYMENT_FAILED: 'FAILED', PAYMENT_REFUNDED: 'REFUNDED', PAYMENT_LARGE: 'SUCCESS', PAYMENT_CREATED: 'CREATED',
  EMAIL_FAILED: 'FAILED', EMAIL_BOUNCED: 'BOUNCED', EMAIL_DELIVERED: 'DELIVERED', EMAIL_SENT: 'SENT',
  WHATSAPP_FAILED: 'FAILED', WHATSAPP_DELIVERED: 'DELIVERED', WHATSAPP_READ: 'READ',
};

const TITLES = { PAYMENT_LARGE: 'LARGE PAYMENT RECEIVED', PAYMENT_REFUNDED: 'REFUND CREATED' };

const LINKS = {
  payment: (d) => ['Open Payment', `/payments${d.paymentId ? `?open=${encodeURIComponent(d.paymentId)}` : ''}`],
  whatsapp: (d) => ['Open Conversation', `/inbox${d.phone ? `?phone=${encodeURIComponent(String(d.phone).replace(/\D/g, ''))}` : ''}`],
  email: () => ['Open Emails', '/email'],
  customer: (d, e) => ['Open Customer', e.customerId ? `/contacts/${e.customerId}` : '/contacts'],
  webhook: () => ['Open Webhooks', '/webhooks'],
  system: () => ['Open System Health', '/system-health'],
  auth: () => ['Open Activity Log', '/activity'],
};

export function formatEvent(event, { dashboardUrl = env.CLIENT_URL, timezone = env.TIMEZONE, includeLink = true, secrets = [] } = {}) {
  const def = EVENT_CATALOG[event.type] || { label: event.type, emoji: 'ℹ️', category: 'system' };
  const data = event.data || {};
  const title = TITLES[event.type] || def.label.toUpperCase();
  const lines = [`${def.emoji} <b>${escapeHtml(title)}</b>`, ''];

  for (const [label, key] of FIELDS[event.type] || []) {
    let value;
    if (key === '$amount') value = data.amount != null ? formatMoney(data.amount, data.currency) : undefined;
    else value = data[key];
    if (value === undefined || value === null || value === '') continue;
    lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(clip(value))}`);
  }
  lines.push(`<b>Time:</b> ${escapeHtml(formatDateTime(event.at || new Date(), timezone))}`);
  if (STATUS[event.type]) lines.push('', `<b>Status:</b> ${STATUS[event.type]}`);

  if (includeLink && LINKS[def.category]) {
    const [text, path] = LINKS[def.category](data, event);
    lines.push('', '<b>Dashboard:</b>', `<a href="${escapeHtml(dashboardUrl.replace(/\/$/, '') + path)}">${escapeHtml(text)}</a>`);
  }
  return scrubSecrets(lines.join('\n').slice(0, 3800), secrets);
}
