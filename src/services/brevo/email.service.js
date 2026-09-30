import { Email, EmailContact, EmailEvent, EmailTemplate, Customer, EMAIL_STATUS_RANK } from '../../models/index.js';
import * as client from './brevo.client.js';
import { requireCredentials, getCredentials, getRawCredentials, isComplete } from '../integration.credentials.js';
import { PROVIDERS, BREVO_ACCOUNTS } from '../../integrations/registry.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getSection } from '../settings.service.js';
import { findOrCreateCustomer, touchCustomer, displayName } from '../customer.service.js';
import { emitEvent } from '../event.bus.js';
import { emitToPermission } from '../socket.js';
import { normalizeEmail, escapeRegex } from '../../utils/phone.js';
import { redactDeep } from '../../utils/redact.js';
import { getPagination, pageMeta } from '../../utils/pagination.js';
import { ApiError } from '../../utils/ApiError.js';

const actorOf = (u) => u && { userId: u.id, name: u.name, role: u.role };
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/* ------------------------------ templates ------------------------------ */

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** {{variable}} substitution. HTML output is escaped so a customer name cannot inject markup. */
export function renderTemplate(source = '', vars = {}, { html = false } = {}) {
  return String(source).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === undefined || v === null) return '';
    return html ? escapeHtml(v) : String(v);
  });
}

export function extractVariables(...sources) {
  const found = new Set();
  for (const s of sources) for (const m of String(s || '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) found.add(m[1]);
  return [...found];
}

export const listTemplates = () => EmailTemplate.find().sort({ name: 1 }).lean();

export async function createTemplate(input, user) {
  const variables = extractVariables(input.subject, input.htmlContent, input.textContent);
  try {
    return await EmailTemplate.create({ ...input, variables, createdBy: user.id });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('A template with this name already exists', 'DUPLICATE_TEMPLATE');
    throw err;
  }
}

export async function updateTemplate(id, patch) {
  const t = await EmailTemplate.findById(id);
  if (!t) throw ApiError.notFound('Template not found');
  Object.assign(t, patch);
  t.variables = extractVariables(t.subject, t.htmlContent, t.textContent);
  try {
    await t.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('A template with this name already exists', 'DUPLICATE_TEMPLATE');
    throw err;
  }
  return t;
}

export async function deleteTemplate(id) {
  const t = await EmailTemplate.findByIdAndDelete(id);
  if (!t) throw ApiError.notFound('Template not found');
}

/** Templates stored inside one Brevo account (they are not shared between accounts). */
export const listRemoteTemplates = (account) => {
  const key = String(account) === '2' || account === 'brevo2' ? 'brevo2' : 'brevo';
  return client.listRemoteTemplates({}, undefined, key);
};

/* ------------------------------ sending accounts ------------------------------ */

/** The two Brevo sending accounts and whether each one is ready to use. No secrets are returned. */
export async function listAccounts() {
  return Promise.all(BREVO_ACCOUNTS.map(async (key, i) => {
    const { values, disabled } = await getRawCredentials(key);
    return {
      key, account: String(i + 1), label: PROVIDERS[key].label,
      configured: !disabled && isComplete(key, values), senderEmail: values.senderEmail || null,
    };
  }));
}

/**
 * Decide which Brevo account(s) to try, in order.
 *  '1' / '2'  -> exactly that account (error if it is not configured)
 *  'auto'     -> every configured account, the one used least in the last 24h first, the other one is the failover
 * When the caller does not choose, BREVO_SEND_MODE from the environment applies (default 'auto').
 */
async function resolveAccounts(choice) {
  const mode = choice && choice !== 'auto' ? choice : env.BREVO_SEND_MODE;
  if (mode === '1' || mode === '2') {
    const key = mode === '1' ? 'brevo' : 'brevo2';
    return [{ key, label: PROVIDERS[key].label, creds: await requireCredentials(key) }];
  }
  const ready = [];
  for (const key of BREVO_ACCOUNTS) {
    const creds = await getCredentials(key);
    if (creds) ready.push({ key, label: PROVIDERS[key].label, creds });
  }
  if (!ready.length) await requireCredentials('brevo'); // throws the standard "not configured" error
  if (ready.length === 1) return ready;
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const used = await Promise.all(ready.map((r) => Email.countDocuments({ brevoAccount: r.key, createdAt: { $gte: since }, status: { $ne: 'failed' } })));
  return used[1] < used[0] ? [ready[1], ready[0]] : ready;
}

/* ------------------------------ contacts ------------------------------ */

async function upsertContact(address, customerId) {
  const email = normalizeEmail(address.email);
  if (!email) return null;
  const set = { lastEmailedAt: new Date(), ...(address.name ? { name: address.name } : {}), ...(customerId ? { customerId } : {}) };
  try {
    return await EmailContact.findOneAndUpdate({ email }, { $set: set, $setOnInsert: { email } }, { upsert: true, new: true });
  } catch (err) {
    if (err?.code === 11000) return EmailContact.findOne({ email });
    throw err;
  }
}

export async function listContacts(query = {}) {
  const pg = getPagination(query);
  const filter = {};
  if (query.blocked === 'true') filter.blocked = true;
  if (query.q) filter.email = { $regex: escapeRegex(query.q), $options: 'i' };
  const [items, total] = await Promise.all([
    EmailContact.find(filter).sort({ lastEmailedAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    EmailContact.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

export async function updateContact(id, patch) {
  const c = await EmailContact.findByIdAndUpdate(id, patch, { new: true });
  if (!c) throw ApiError.notFound('Contact not found');
  return c;
}

/* ------------------------------ sending ------------------------------ */

const toAddr = (a) => (typeof a === 'string' ? { email: a } : a);

/**
 * Send an email through Brevo. The row is stored as `queued` first so a provider failure is still visible in history.
 * input: { to[], cc[], bcc[], subject, htmlContent, textContent, templateId, variables, customerId, attachments[{name, contentBase64}] }
 */
export async function sendEmail(input, user) {
  const settings = await getSection('email');
  let accounts = await resolveAccounts(input.account);

  // The sender address must be verified inside the Brevo account that sends it, so the account's own sender wins
  // over the global default from Email settings.
  const senderFor = (creds) => ({
    email: normalizeEmail(input.senderEmail || creds.senderEmail || settings.defaultSenderEmail),
    name: input.senderName || creds.senderName || settings.defaultSenderName || undefined,
  });
  accounts = accounts.map((a) => ({ ...a, sender: senderFor(a.creds) })).filter((a, _i, all) => a.sender.email || all.length === 1);
  if (!accounts.length || !accounts[0].sender.email) throw ApiError.badRequest('No sender email configured. Set a default sender email on the Brevo account in Integrations, or in Email settings.', 'SENDER_MISSING');
  const senderEmail = accounts[0].sender.email;
  const senderName = accounts[0].sender.name;

  const to = (input.to || []).map(toAddr);
  const cc = (input.cc || []).map(toAddr);
  const bcc = (input.bcc || []).map(toAddr);
  const all = [...to, ...cc, ...bcc];
  if (!to.length) throw ApiError.badRequest('At least one recipient is required');

  // Refuse blocked recipients (hard bounce / spam complaint / unsubscribe) instead of hurting sender reputation.
  const blocked = await EmailContact.find({ email: { $in: all.map((a) => normalizeEmail(a.email)).filter(Boolean) }, $or: [{ blocked: true }, { subscribed: false }] }).select('email').lean();
  if (blocked.length) {
    throw ApiError.unprocessable(`Recipient cannot receive email (bounced, blocked or unsubscribed): ${blocked.map((b) => b.email).join(', ')}`, 'RECIPIENT_BLOCKED');
  }

  let template = null;
  if (input.templateId) {
    template = await EmailTemplate.findById(input.templateId);
    if (!template || !template.enabled) throw ApiError.notFound('Email template not found or disabled');
  }
  const vars = input.variables || {};
  const subject = template ? renderTemplate(input.subject || template.subject, vars) : input.subject;
  const htmlContent = template ? renderTemplate(input.htmlContent || template.htmlContent, vars, { html: true }) : input.htmlContent;
  const textContent = template ? renderTemplate(input.textContent || template.textContent, vars) : input.textContent;
  if (!subject) throw ApiError.badRequest('Subject is required');
  if (!htmlContent && !textContent) throw ApiError.badRequest('Provide HTML or text content');

  const attachments = input.attachments || [];
  let total = 0;
  for (const a of attachments) total += Math.ceil((a.contentBase64.length * 3) / 4);
  if (total > MAX_ATTACHMENT_BYTES) throw ApiError.badRequest('Attachments exceed the 4 MB limit', 'ATTACHMENT_TOO_LARGE');

  // Resolve the customer this email belongs to (never creates duplicates: email-only lookup is conservative).
  let customerId = input.customerId;
  if (!customerId) {
    const { customer } = await findOrCreateCustomer({ email: to[0].email, name: to[0].name, source: 'Email', actor: user });
    customerId = customer?._id;
  }

  const record = await Email.create({
    from: { email: senderEmail, name: senderName }, to, cc, bcc, subject, htmlContent, textContent,
    templateId: template?._id, attachments: attachments.map((a) => ({ name: a.name, size: Math.ceil((a.contentBase64.length * 3) / 4) })),
    status: 'queued', customerId, sentBy: user.id, brevoAccount: accounts[0].key,
  });

  const buildPayload = (sender) => ({
    sender: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) },
    to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}),
    subject,
    ...(htmlContent ? { htmlContent } : {}),
    ...(textContent ? { textContent } : {}),
    ...(settings.replyToEmail ? { replyTo: { email: settings.replyToEmail } } : {}),
    ...(attachments.length ? { attachment: attachments.map((a) => ({ name: a.name, content: a.contentBase64 })) } : {}),
  });
  // Brevo requires htmlContent or textContent; when only text is provided it sends text.

  const toLabel = to.map((t) => t.email).join(', ');
  const customer = customerId ? await Customer.findById(customerId) : null;
  // Try the chosen account first; in auto mode the other account is the failover if Brevo rejects the request
  // (daily limit reached, invalid key, account suspended, ...).
  let sentVia = null;
  let sendError = null;
  for (const [i, acct] of accounts.entries()) {
    try {
      const res = await client.sendEmail(buildPayload(acct.sender), acct.creds, acct.key);
      record.status = 'sent';
      record.messageId = res.messageId;
      record.brevoAccount = acct.key;
      record.from = { email: acct.sender.email, name: acct.sender.name };
      record.lastEventAt = new Date();
      await record.save();
      sentVia = acct;
      break;
    } catch (err) {
      sendError = Object.assign(err, { message: accounts.length > 1 ? `${acct.label}: ${err.message}` : err.message });
      if (i < accounts.length - 1) logger.warn({ account: acct.key, err: err.message }, 'Brevo send failed, trying the other account');
    }
  }
  if (!sentVia) {
    const err = sendError;
    record.status = 'failed';
    record.error = { code: err.providerCode || String(err.providerStatus || ''), message: err.message };
    record.lastEventAt = new Date();
    await record.save();
    await EmailEvent.create({ emailId: record._id, event: 'failed', recipient: toLabel, reason: err.message, occurredAt: new Date() });
    await emitEvent('EMAIL_FAILED', {
      customerId, actor: actorOf(user), actorType: 'user', source: 'email', description: `Email "${subject}" to ${toLabel} failed: ${err.message}`,
      metadata: { emailId: String(record._id) }, data: { to: toLabel, subject, reason: err.message },
    });
    emitToPermission('email:read', 'email:update', { emailId: String(record._id), status: 'failed' });
    throw err;
  }

  await Promise.all(all.map((a) => upsertContact(a, a === to[0] ? customerId : undefined)));
  await EmailEvent.create({ emailId: record._id, messageId: record.messageId, event: 'sent', recipient: toLabel, occurredAt: new Date() });
  await touchCustomer(customerId);
  emitToPermission('email:read', 'email:update', { emailId: String(record._id), status: 'sent' });
  await emitEvent('EMAIL_SENT', {
    customerId, actor: actorOf(user), actorType: 'user', source: 'email', description: `${user.name} sent "${subject}" to ${toLabel} via ${sentVia.label}`,
    metadata: { emailId: String(record._id), messageId: record.messageId, account: sentVia.key, customer: customer ? displayName(customer) : undefined },
    data: { to: toLabel, subject, sentBy: user.name },
  });
  return record;
}

/* ------------------------------ webhook processing ------------------------------ */

const EVENT_TO_STATUS = {
  request: 'sent', sent: 'sent', delivered: 'delivered', opened: 'opened', uniqueopened: 'opened', unique_opened: 'opened', proxy_open: 'opened',
  click: 'clicked', clicks: 'clicked', softbounce: 'soft_bounced', soft_bounce: 'soft_bounced', hardbounce: 'bounced', hard_bounce: 'bounced',
  blocked: 'blocked', spam: 'spam', complaint: 'spam', invalid: 'invalid', invalid_email: 'invalid', deferred: 'deferred', error: 'failed',
  unsubscribed: 'unsubscribed', unsubscribe: 'unsubscribed',
};

export const brevoEventName = (p) => String(p.event || '').toLowerCase().replace(/[\s-]/g, '');

/** Deterministic id per Brevo event (Brevo sends no event id). */
export function brevoEventId(p, payloadHash) {
  const ts = p.ts_event || p.ts_epoch || p.ts || p.date || '';
  const base = `${p['message-id'] || p.messageId || p.id || ''}:${brevoEventName(p)}:${String(p.email || '').toLowerCase()}:${ts}`;
  return p.link ? `${base}:${p.link}` : base.length > 8 ? base : `h:${payloadHash}`;
}

function eventDate(p) {
  const raw = p.ts_epoch ?? p.ts_event ?? p.ts ?? p.date;
  if (raw === undefined || raw === null || raw === '') return new Date();
  const d = /^\d+$/.test(String(raw)) ? new Date(Number(raw) * (String(raw).length <= 10 ? 1000 : 1)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Process one Brevo webhook object. */
export async function processBrevoItem(p) {
  const name = brevoEventName(p);
  const status = EVENT_TO_STATUS[name];
  if (!status) return { ignored: true, result: `unsupported event "${name}"` };

  const messageId = p['message-id'] || p.messageId;
  const recipient = normalizeEmail(p.email);
  let email = null;
  if (messageId) {
    email = await Email.findOne({ messageId });
    if (!email) email = await Email.findOne({ messageId: String(messageId).replace(/^<|>$/g, '') });
    if (!email) email = await Email.findOne({ messageId: `<${String(messageId).replace(/^<|>$/g, '')}>` });
  }
  const at = eventDate(p);
  await EmailEvent.create({
    emailId: email?._id, messageId, event: name, recipient: p.email, reason: p.reason, link: p.link, occurredAt: at, payload: redactDeep(p),
  });

  // Address-level hygiene applies even for emails that were not sent from this dashboard.
  if (recipient && ['bounced', 'blocked', 'spam', 'invalid', 'unsubscribed'].includes(status)) {
    const set = status === 'unsubscribed' ? { subscribed: false } : { blocked: true };
    await EmailContact.findOneAndUpdate({ email: recipient }, { $set: set, $inc: status === 'bounced' ? { bounceCount: 1 } : {}, $setOnInsert: { email: recipient } }, { upsert: true }).catch(() => {});
  }
  if (!email) return { ignored: true, result: 'no matching email record' };

  const rank = EMAIL_STATUS_RANK;
  const set = { lastEventAt: at };
  const inc = {};
  if (status === 'delivered') { set.delivered = true; set.deliveredAt = email.deliveredAt || at; }
  if (status === 'opened') { set.opened = true; set.firstOpenedAt = email.firstOpenedAt || at; if (!email.delivered) set.delivered = true; }
  if (status === 'clicked') { set.clicked = true; set.opened = true; if (!email.delivered) set.delivered = true; }
  if (status === 'bounced') set.bounced = true;
  if (status === 'opened') inc.openCount = 1;
  if (status === 'clicked') inc.clickCount = 1;

  const advance = (rank[status] ?? 0) > (rank[email.status] ?? 0) && !(email.status === 'bounced' || email.status === 'failed');
  if (advance) set.status = status;
  if (['bounced', 'blocked', 'invalid', 'spam', 'failed'].includes(status)) set.error = { code: name, message: p.reason || name };

  const update = { $set: set, ...(Object.keys(inc).length ? { $inc: inc } : {}) };
  await Email.updateOne({ _id: email._id }, update);
  emitToPermission('email:read', 'email:update', { emailId: String(email._id), status: advance ? status : email.status });

  const to = email.to.map((t) => t.email).join(', ');
  const base = { customerId: email.customerId, actorType: 'webhook', source: 'email', metadata: { emailId: String(email._id) }, data: { to, subject: email.subject, reason: p.reason } };
  if (status === 'delivered' && !email.delivered) await emitEvent('EMAIL_DELIVERED', { ...base, description: `Email "${email.subject}" delivered to ${p.email}` });
  else if (['bounced', 'soft_bounced'].includes(status) && !email.bounced && status === 'bounced') await emitEvent('EMAIL_BOUNCED', { ...base, description: `Email "${email.subject}" bounced for ${p.email}: ${p.reason || 'no reason given'}` });
  else if (['blocked', 'invalid', 'spam', 'failed'].includes(status) && email.status !== status) await emitEvent('EMAIL_FAILED', { ...base, description: `Email "${email.subject}" to ${p.email} ${status}: ${p.reason || ''}`.trim() });
  return { result: `email ${status}` };
}

/* ------------------------------ queries ------------------------------ */

export async function listEmails(query = {}) {
  const pg = getPagination(query);
  const filter = {};
  if (query.status) filter.status = { $in: String(query.status).split(',') };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lt = new Date(query.to);
  }
  if (query.q) {
    const rx = { $regex: escapeRegex(query.q), $options: 'i' };
    filter.$or = [{ subject: rx }, { 'to.email': rx }, { 'from.email': rx }];
  }
  const [items, total] = await Promise.all([
    Email.find(filter).select('-htmlContent -textContent').sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('customerId', 'firstName lastName email').populate('sentBy', 'name').lean(),
    Email.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}

export async function getEmail(id) {
  const email = await Email.findById(id).populate('customerId', 'firstName lastName email phone').populate('sentBy', 'name').lean();
  if (!email) throw ApiError.notFound('Email not found');
  const events = await EmailEvent.find({ emailId: email._id }).sort({ occurredAt: 1 }).select('-payload').lean();
  return { ...email, events };
}

export async function emailStats(from, to) {
  const rows = await Email.find({ createdAt: { $gte: from, $lt: to } }).select('status delivered opened clicked bounced brevoAccount').lean();
  const s = { total: rows.length, sent: 0, delivered: 0, failed: 0, bounced: 0, opened: 0, clicked: 0, byAccount: { brevo: 0, brevo2: 0 } };
  for (const r of rows) {
    if (r.brevoAccount && r.status !== 'queued' && r.status !== 'failed') s.byAccount[r.brevoAccount] += 1;
    if (r.status !== 'queued' && r.status !== 'failed') s.sent += 1;
    if (r.delivered) s.delivered += 1;
    if (r.status === 'failed' || ['blocked', 'invalid', 'spam'].includes(r.status)) s.failed += 1;
    if (r.bounced) s.bounced += 1;
    if (r.opened) s.opened += 1;
    if (r.clicked) s.clicked += 1;
  }
  return s;
}
