import { WhatsAppConversation, WhatsAppMessage, WhatsAppContact, WhatsAppEvent, WhatsAppTemplate, Customer } from '../../models/index.js';
import * as client from './msg91.client.js';
import { findOrCreateCustomer, touchCustomer, displayName } from '../customer.service.js';
import { emitEvent } from '../event.bus.js';
import { emitToPermission } from '../socket.js';
import { getSection } from '../settings.service.js';
import { resolveAccount } from '../integration.credentials.js';
import { normalizePhone } from '../../utils/phone.js';
import { redactDeep } from '../../utils/redact.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizeMsg91 } from './whatsapp.parser.js';

const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };
const WINDOW_MS = 24 * 3600 * 1000;
const preview = (m) => (m.text || (m.type !== 'text' ? `[${m.type}]` : '')).slice(0, 140);
const actorOf = (u) => u && { userId: u.id, name: u.name, role: u.role };

async function upsertConversation(phone, customer, contact) {
  const q = { phone };
  const set = { $setOnInsert: { phone, customerId: customer?._id, contactId: contact?._id } };
  try {
    return await WhatsAppConversation.findOneAndUpdate(q, set, { upsert: true, new: true });
  } catch (err) {
    if (err?.code === 11000) return WhatsAppConversation.findOne(q);
    throw err;
  }
}

async function ensureContact(phone, customer, profileName) {
  const contact = await WhatsAppContact.findOneAndUpdate(
    { phone },
    { $set: { lastSeenAt: new Date(), ...(customer ? { customerId: customer._id } : {}), ...(profileName ? { profileName } : {}) }, $setOnInsert: { phone } },
    { upsert: true, new: true }
  ).catch(async (err) => { if (err?.code === 11000) return WhatsAppContact.findOne({ phone }); throw err; });
  return contact;
}

/* ------------------------------ inbound ------------------------------ */

export async function handleInbound(n, account = 'msg91') {
  if (!n.phone) throw new Error('Inbound message has no valid customer number');
  if (n.providerMessageId) {
    const dup = await WhatsAppMessage.findOne({ providerMessageId: n.providerMessageId }).select('_id');
    if (dup) return { ignored: true, result: 'duplicate message' };
  }
  const { customer } = await findOrCreateCustomer({ phone: n.phone, name: n.profileName, source: 'WhatsApp' });
  const contact = await ensureContact(n.phone, customer, n.profileName);
  const conv = await upsertConversation(n.phone, customer, contact);
  if (customer && !conv.customerId) { conv.customerId = customer._id; }

  const at = n.ts && !Number.isNaN(n.ts.getTime()) ? n.ts : new Date();
  let message;
  try {
    message = await WhatsAppMessage.create({
      conversationId: conv._id, customerId: customer?._id, phone: n.phone, account, direction: 'in', type: n.type, text: n.text,
      media: n.media, providerMessageId: n.providerMessageId, providerRequestId: n.requestId, status: 'received',
      statusHistory: [{ status: 'received', at }], providerTimestamp: at,
    });
  } catch (err) {
    if (err?.code === 11000) return { ignored: true, result: 'duplicate message' };
    throw err;
  }

  await WhatsAppConversation.updateOne(
    { _id: conv._id },
    {
      $inc: { unreadCount: 1, messageCount: 1 },
      $set: {
        lastMessageAt: at, lastMessagePreview: preview(message), lastMessageDirection: 'in', lastInboundAt: at, markedUnread: false, account,
        ...(conv.customerId ? { customerId: conv.customerId } : {}),
        ...(['resolved', 'archived'].includes(conv.status) ? { status: 'open' } : {}),
      },
    }
  );
  await touchCustomer(customer?._id, at);
  await WhatsAppEvent.create({ type: 'inbound', providerMessageId: n.providerMessageId, phone: n.phone, messageId: message._id, matched: true, payload: redactDeep(n.raw) });

  const name = displayName(customer) || n.profileName || `+${n.phone}`;
  emitToPermission('whatsapp:read', 'whatsapp:message:new', { conversationId: String(conv._id), message: message.toObject(), customerName: name });
  await emitEvent('WHATSAPP_RECEIVED', {
    customerId: customer?._id, actorType: 'customer', source: 'whatsapp', description: `WhatsApp message from ${name}`,
    metadata: { conversationId: String(conv._id), messageId: String(message._id), type: n.type },
    data: { customer: name, phone: n.phone, preview: preview(message) },
  });
  return { result: 'inbound stored' };
}

/* ------------------------------ delivery status ------------------------------ */

async function findOutbound(n) {
  if (n.providerMessageId) {
    const m = await WhatsAppMessage.findOne({ providerMessageId: n.providerMessageId, direction: 'out' });
    if (m) return m;
  }
  if (n.requestId) {
    const m = await WhatsAppMessage.findOne({ providerRequestId: n.requestId, direction: 'out' });
    if (m) return m;
  }
  if (n.phone) {
    // Fall back to the most recent unmatched outbound message to this number.
    return WhatsAppMessage.findOne({
      phone: n.phone, direction: 'out', providerMessageId: { $exists: false }, status: { $in: ['queued', 'sent'] },
      createdAt: { $gte: new Date(Date.now() - 15 * 60000) },
    }).sort({ createdAt: -1 });
  }
  return null;
}

export async function handleStatus(n) {
  const msg = await findOutbound(n);
  await WhatsAppEvent.create({
    type: 'status', status: n.status, providerMessageId: n.providerMessageId, phone: n.phone, messageId: msg?._id,
    matched: Boolean(msg), payload: redactDeep(n.raw),
  });
  if (!msg) return { ignored: true, result: 'no matching outbound message' };

  const at = n.ts && !Number.isNaN(n.ts.getTime()) ? n.ts : new Date();
  const set = {};
  if (!msg.providerMessageId && n.providerMessageId) set.providerMessageId = n.providerMessageId;
  let changed = false;

  if (n.status === 'failed') {
    if (!['delivered', 'read', 'failed'].includes(msg.status)) {
      Object.assign(set, { status: 'failed', failedAt: at, error: { code: n.reason?.split(':')[0], message: n.reason || 'Delivery failed' } });
      changed = true;
    }
  } else if (RANK[n.status] > (RANK[msg.status] ?? -1) && msg.status !== 'failed') {
    Object.assign(set, { status: n.status });
    if (n.status === 'sent') set.sentAt = msg.sentAt || at;
    if (n.status === 'delivered') set.deliveredAt = at;
    if (n.status === 'read') { set.readAt = at; set.deliveredAt = msg.deliveredAt || at; }
    changed = true;
  }
  if (!Object.keys(set).length) return { ignored: true, result: 'stale status' };

  const update = { $set: set };
  if (changed) update.$push = { statusHistory: { status: set.status, at } };
  const updated = await WhatsAppMessage.findOneAndUpdate({ _id: msg._id }, update, { new: true });

  emitToPermission('whatsapp:read', 'whatsapp:message:status', { conversationId: String(msg.conversationId), messageId: String(msg._id), status: updated.status, error: updated.error });
  if (changed) {
    const customer = msg.customerId ? await Customer.findById(msg.customerId) : null;
    const name = customer ? displayName(customer) : `+${msg.phone}`;
    const type = { delivered: 'WHATSAPP_DELIVERED', read: 'WHATSAPP_READ', failed: 'WHATSAPP_FAILED' }[updated.status];
    if (type) {
      await emitEvent(type, {
        customerId: msg.customerId, actorType: 'webhook', source: 'whatsapp', description: `WhatsApp message to ${name} ${updated.status}`,
        metadata: { messageId: String(msg._id) }, data: { customer: name, phone: msg.phone, reason: updated.error?.message },
      });
    }
  }
  return { result: `status ${updated.status}` };
}

/** Processor used by the webhook route and by retries. Accepts one payload object. */
export async function processMsg91Item(payload, account = 'msg91') {
  const n = normalizeMsg91(payload);
  if (n.kind === 'inbound') return handleInbound(n, account);
  if (n.kind === 'status') return handleStatus(n);
  return { ignored: true, result: 'unsupported event' };
}

/* ------------------------------ outbound ------------------------------ */

function insideSessionWindow(conv) {
  return Boolean(conv.lastInboundAt && Date.now() - conv.lastInboundAt.getTime() < WINDOW_MS);
}

export async function resolveConversationForSend({ conversationId, phone, customerId }, user) {
  if (conversationId) {
    const c = await WhatsAppConversation.findById(conversationId);
    if (!c) throw ApiError.notFound('Conversation not found');
    return c;
  }
  let target = normalizePhone(phone);
  let customer = null;
  if (customerId) {
    customer = await Customer.findById(customerId);
    if (!customer) throw ApiError.notFound('Customer not found');
    target = target || customer.phone;
  }
  if (!target) throw ApiError.badRequest('A valid phone number is required', 'INVALID_PHONE');
  if (!customer) ({ customer } = await findOrCreateCustomer({ phone: target, source: 'WhatsApp', actor: user }));
  const contact = await ensureContact(target, customer);
  return upsertConversation(target, customer, contact);
}

/**
 * Send a WhatsApp message (text | template | image|video|audio|document) from the dashboard.
 * The message row is written first (status queued) so a provider outage never loses what the operator typed.
 */
export async function sendMessage(input, user) {
  const conv = await resolveConversationForSend(input, user);
  // An explicitly chosen number must work; otherwise reply from the number the customer wrote to, else the default.
  const { key: account, creds } = input.account
    ? await resolveAccount('msg91', input.account)
    : await resolveAccount('msg91', conv.account, { strict: false });
  const type = input.type || 'text';

  if (type !== 'template' && !insideSessionWindow(conv)) {
    throw ApiError.conflict('The 24-hour customer-service window is closed. Send an approved template message instead.', 'OUTSIDE_SESSION_WINDOW');
  }

  let templateDef = null;
  if (type === 'template') {
    templateDef = input.templateId ? await WhatsAppTemplate.findById(input.templateId) : await WhatsAppTemplate.findOne({ name: input.template?.name, language: input.template?.language || 'en' });
    if (!templateDef && !input.template?.name) throw ApiError.badRequest('Choose a template');
  }
  const tName = templateDef?.name || input.template?.name;
  const tLang = templateDef?.language || input.template?.language || 'en';
  const variables = (input.template?.variables || []).map(String);

  const message = await WhatsAppMessage.create({
    conversationId: conv._id, customerId: conv.customerId, phone: conv.phone, account, direction: 'out', type,
    text: type === 'text' ? input.text : type === 'template' ? (templateDef?.bodyText ? templateDef.bodyText.replace(/\{\{(\d+)\}\}/g, (_, i) => variables[i - 1] ?? '') : `Template: ${tName}`) : input.media?.caption || '',
    media: ['image', 'video', 'audio', 'document'].includes(type) ? input.media : undefined,
    template: type === 'template' ? { name: tName, language: tLang, variables } : undefined,
    status: 'queued', statusHistory: [{ status: 'queued', at: new Date() }], sentBy: user.id,
  });

  try {
    let res;
    if (type === 'text') res = await client.sendText({ to: conv.phone, text: input.text }, creds, account);
    else if (type === 'template') res = await client.sendTemplate({ to: conv.phone, name: tName, language: tLang, namespace: templateDef?.namespace, variables }, creds, account);
    else res = await client.sendMedia({ to: conv.phone, type, link: input.media.url, caption: input.media.caption, filename: input.media.filename }, creds, account);

    message.status = 'sent';
    message.sentAt = new Date();
    message.providerRequestId = res.requestId;
    if (res.messageId) message.providerMessageId = res.messageId;
    message.statusHistory.push({ status: 'sent', at: message.sentAt });
    await message.save();
  } catch (err) {
    message.status = 'failed';
    message.failedAt = new Date();
    message.error = { code: err.providerCode || String(err.providerStatus || ''), message: err.message };
    message.statusHistory.push({ status: 'failed', at: message.failedAt });
    await message.save();
    const customer = conv.customerId ? await Customer.findById(conv.customerId) : null;
    const name = displayName(customer) || `+${conv.phone}`;
    await emitEvent('WHATSAPP_FAILED', {
      customerId: conv.customerId, actor: actorOf(user), actorType: 'user', source: 'whatsapp', description: `WhatsApp message to ${name} failed: ${err.message}`,
      metadata: { messageId: String(message._id) }, data: { customer: name, phone: conv.phone, reason: err.message },
    });
    emitToPermission('whatsapp:read', 'whatsapp:message:status', { conversationId: String(conv._id), messageId: String(message._id), status: 'failed', error: message.error });
    throw err;
  }

  const settings = await getSection('whatsapp');
  const set = { lastMessageAt: message.sentAt, lastMessagePreview: preview(message), lastMessageDirection: 'out', unreadCount: 0, markedUnread: false };
  if (settings.autoAssignToFirstReplier && !conv.assignedTo) set.assignedTo = user.id;
  if (conv.status === 'resolved' || conv.status === 'pending') set.status = 'open';
  await WhatsAppConversation.updateOne({ _id: conv._id }, { $set: set, $inc: { messageCount: 1 } });
  await touchCustomer(conv.customerId, message.sentAt);

  const customer = conv.customerId ? await Customer.findById(conv.customerId) : null;
  const name = displayName(customer) || `+${conv.phone}`;
  emitToPermission('whatsapp:read', 'whatsapp:message:new', { conversationId: String(conv._id), message: message.toObject(), customerName: name });
  await emitEvent('WHATSAPP_SENT', {
    customerId: conv.customerId, actor: actorOf(user), actorType: 'user', source: 'whatsapp', description: `${user.name} sent WhatsApp to ${name}`,
    metadata: { messageId: String(message._id), type }, data: { customer: name, phone: conv.phone, preview: preview(message), sentBy: user.name },
  });
  return message;
}
