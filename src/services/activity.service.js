import { ActivityLog } from '../models/index.js';
import { redactDeep } from '../utils/redact.js';
import { getPagination, pageMeta } from '../utils/pagination.js';
import { escapeRegex } from '../utils/phone.js';

export async function logActivity(event) {
  if (!event.def.activity) return null;
  return ActivityLog.create({
    eventType: event.type,
    severity: event.def.severity,
    actorType: event.actorType || 'system',
    actor: event.actor ? { userId: event.actor.userId, name: event.actor.name, role: event.actor.role } : undefined,
    customerId: event.customerId || undefined,
    source: event.source || event.def.category,
    description: event.description || event.def.label,
    metadata: redactDeep(event.metadata || {}),
    ipAddress: event.ip,
  });
}

export async function listActivity(query = {}) {
  const pg = getPagination(query, { defaultLimit: 30, maxLimit: 200 });
  const filter = {};
  if (query.eventType) filter.eventType = { $in: String(query.eventType).split(',') };
  if (query.source) filter.source = { $in: String(query.source).split(',') };
  if (query.severity) filter.severity = { $in: String(query.severity).split(',') };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lt = new Date(query.to);
  }
  if (query.q) filter.description = { $regex: escapeRegex(query.q), $options: 'i' };
  const [items, total] = await Promise.all([
    ActivityLog.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).populate('customerId', 'firstName lastName phone').lean(),
    ActivityLog.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}
