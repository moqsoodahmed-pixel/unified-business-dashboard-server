import { Customer, WhatsAppConversation, WhatsAppMessage, Email, Payment, ActivityLog } from '../models/index.js';
import { escapeRegex } from '../utils/phone.js';
import { displayName } from './customer.service.js';

const rxOf = (q) => new RegExp(escapeRegex(q.trim().replace(/^\+/, '')), 'i');

/**
 * Global search across every module the caller may read. Each hit carries `source` and a client `route`
 * so the header search can navigate straight to it.
 */
export async function globalSearch(q, user, { limit = 5 } = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) return { query: term, results: [], groups: {} };
  const rx = rxOf(term);
  const can = (p) => user.permissions.includes(p);
  const jobs = [];

  if (can('customers:read')) {
    jobs.push(Customer.find({ $or: [{ firstName: rx }, { lastName: rx }, { email: rx }, { phone: rx }, { company: rx }] }).sort({ lastInteractionAt: -1 }).limit(limit).lean().then((rows) =>
      rows.map((c) => ({ source: 'Customer', id: String(c._id), title: displayName(c), subtitle: [c.phone && `+${c.phone}`, c.email, c.company].filter(Boolean).join(' · '), route: `/contacts/${c._id}` }))));
  }
  if (can('whatsapp:read')) {
    jobs.push((async () => {
      const customers = await Customer.find({ $or: [{ firstName: rx }, { lastName: rx }, { phone: rx }] }).select('_id').limit(50).lean();
      const inMsgs = await WhatsAppMessage.find({ text: rx }).sort({ createdAt: -1 }).select('conversationId').limit(20).lean();
      const rows = await WhatsAppConversation.find({ $or: [{ phone: rx }, { lastMessagePreview: rx }, { customerId: { $in: customers.map((c) => c._id) } }, { _id: { $in: inMsgs.map((m) => m.conversationId) } }] })
        .sort({ lastMessageAt: -1 }).limit(limit).populate('customerId', 'firstName lastName').lean();
      return rows.map((c) => ({ source: 'WhatsApp', id: String(c._id), title: c.customerId ? displayName(c.customerId) : `+${c.phone}`, subtitle: c.lastMessagePreview, route: `/inbox?conversation=${c._id}` }));
    })());
  }
  if (can('email:read')) {
    jobs.push(Email.find({ $or: [{ subject: rx }, { 'to.email': rx }] }).select('subject to status createdAt').sort({ createdAt: -1 }).limit(limit).lean().then((rows) =>
      rows.map((e) => ({ source: 'Email', id: String(e._id), title: e.subject || '(no subject)', subtitle: `${e.to.map((t) => t.email).join(', ')} · ${e.status}`, route: `/email?open=${e._id}` }))));
  }
  if (can('payments:read')) {
    jobs.push(Payment.find({ $or: [{ paymentId: rx }, { orderId: rx }, { email: rx }, { contact: rx }] }).sort({ razorpayCreatedAt: -1 }).limit(limit).lean().then((rows) =>
      rows.map((p) => ({ source: 'Payment', id: String(p._id), title: p.paymentId, subtitle: `${p.currency} ${(p.amount / 100).toFixed(2)} · ${p.status}${p.email ? ` · ${p.email}` : ''}`, route: `/payments?open=${p.paymentId}` }))));
  }
  if (can('activity:read')) {
    jobs.push(ActivityLog.find({ description: rx }).sort({ createdAt: -1 }).limit(limit).lean().then((rows) =>
      rows.map((a) => ({ source: 'Activity', id: String(a._id), title: a.eventType, subtitle: a.description, route: `/activity?q=${encodeURIComponent(term)}` }))));
  }

  const settled = await Promise.allSettled(jobs);
  const results = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value);
  const groups = {};
  for (const r of results) (groups[r.source] ||= []).push(r);
  return { query: term, results, groups };
}
