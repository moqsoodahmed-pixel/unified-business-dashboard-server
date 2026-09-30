import { WhatsAppConversation, WhatsAppMessage, WhatsAppTemplate, Customer } from '../../models/index.js';
import { getPagination, pageMeta } from '../../utils/pagination.js';
import { escapeRegex } from '../../utils/phone.js';
import { ApiError } from '../../utils/ApiError.js';
import { emitToPermission } from '../socket.js';

const POPULATE = [{ path: 'customerId', select: 'firstName lastName phone email tags status' }, { path: 'assignedTo', select: 'name role' }];

export async function listConversations(query, user) {
  const pg = getPagination(query, { defaultLimit: 30, maxLimit: 100 });
  const filter = {};
  const view = query.view || 'all';
  if (view === 'archived') filter.status = 'archived';
  else filter.status = query.status ? query.status : { $ne: 'archived' };
  if (view === 'unread') filter.$or = [{ unreadCount: { $gt: 0 } }, { markedUnread: true }];
  if (view === 'mine') filter.assignedTo = user.id;
  if (view === 'recent') filter.lastMessageAt = { $gte: new Date(Date.now() - 24 * 3600 * 1000) };
  if (view === 'priority') filter.priority = { $in: ['high', 'urgent'] };
  if (query.assignedTo) filter.assignedTo = query.assignedTo === 'none' ? null : query.assignedTo;
  if (query.tag) filter.tags = query.tag;
  if (query.phone) filter.phone = String(query.phone).replace(/\D/g, '');

  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q).trim().replace(/^\+/, '')), 'i');
    const customers = await Customer.find({ $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }] }).select('_id').limit(100).lean();
    const inMessages = await WhatsAppMessage.find({ text: rx }).select('conversationId').limit(200).lean();
    const clause = [{ phone: rx }, { lastMessagePreview: rx }, { customerId: { $in: customers.map((c) => c._id) } }, { _id: { $in: inMessages.map((m) => m.conversationId) } }];
    filter.$and = [...(filter.$and || []), { $or: clause }];
  }
  const [items, total, unreadTotal] = await Promise.all([
    WhatsAppConversation.find(filter).sort({ lastMessageAt: -1 }).skip(pg.skip).limit(pg.limit).populate(POPULATE).lean(),
    WhatsAppConversation.countDocuments(filter),
    WhatsAppConversation.countDocuments({ status: { $ne: 'archived' }, $or: [{ unreadCount: { $gt: 0 } }, { markedUnread: true }] }),
  ]);
  return { items, unreadTotal, ...pageMeta(total, pg) };
}

export async function getConversation(id) {
  const c = await WhatsAppConversation.findById(id).populate(POPULATE).lean();
  if (!c) throw ApiError.notFound('Conversation not found');
  c.windowOpen = Boolean(c.lastInboundAt && Date.now() - new Date(c.lastInboundAt).getTime() < 24 * 3600 * 1000);
  return c;
}

/** Messages oldest→newest. `before` (ISO date/id) pages backwards; `q` searches inside the conversation. */
export async function listMessages(id, query = {}) {
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));
  const filter = { conversationId: id };
  if (query.before) filter.createdAt = { $lt: new Date(query.before) };
  if (query.q) filter.text = { $regex: escapeRegex(query.q), $options: 'i' };
  const rows = await WhatsAppMessage.find(filter).sort({ createdAt: -1 }).limit(limit + 1).populate('sentBy', 'name').lean();
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit).reverse(), hasMore };
}

async function mutate(id, update) {
  const c = await WhatsAppConversation.findByIdAndUpdate(id, update, { new: true }).populate(POPULATE).lean();
  if (!c) throw ApiError.notFound('Conversation not found');
  emitToPermission('whatsapp:read', 'whatsapp:conversation:update', { conversationId: String(c._id), unreadCount: c.unreadCount, markedUnread: c.markedUnread, status: c.status, assignedTo: c.assignedTo, priority: c.priority });
  return c;
}

export const markRead = (id) => mutate(id, { $set: { unreadCount: 0, markedUnread: false } });
export const markUnread = (id) => mutate(id, { $set: { markedUnread: true } });
export const archive = (id) => mutate(id, { $set: { status: 'archived' } });
export const unarchive = (id) => mutate(id, { $set: { status: 'open' } });
export const setStatus = (id, status) => mutate(id, { $set: { status } });
export const setPriority = (id, priority) => mutate(id, { $set: { priority } });
export const addTag = (id, tag) => mutate(id, { $addToSet: { tags: tag } });
export const removeTag = (id, tag) => mutate(id, { $pull: { tags: tag } });
export const addNote = (id, text, user) => mutate(id, { $push: { notes: { text, author: user.id, authorName: user.name } } });

export async function assign(id, userId) {
  return mutate(id, { $set: { assignedTo: userId || null } });
}

/* templates */
export const listTemplates = () => WhatsAppTemplate.find().sort({ name: 1 }).lean();
export async function createTemplate(input, user) {
  try { return await WhatsAppTemplate.create({ ...input, createdBy: user.id }); }
  catch (err) { if (err?.code === 11000) throw ApiError.conflict('A template with this name and language exists', 'DUPLICATE_TEMPLATE'); throw err; }
}
export async function updateTemplate(id, patch) {
  const t = await WhatsAppTemplate.findByIdAndUpdate(id, patch, { new: true });
  if (!t) throw ApiError.notFound('Template not found');
  return t;
}
export async function deleteTemplate(id) {
  const t = await WhatsAppTemplate.findByIdAndDelete(id);
  if (!t) throw ApiError.notFound('Template not found');
}
