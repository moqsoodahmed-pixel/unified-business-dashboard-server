import { EVENT_CATALOG } from '../constants/events.js';
import { logger } from '../config/logger.js';

const handlers = [];
export const registerHandler = (fn) => { if (!handlers.includes(fn)) handlers.push(fn); };
export const clearHandlers = () => { handlers.length = 0; };

/**
 * Publish a domain event. Handlers (activity log, sockets, Telegram) run independently:
 * one failing never blocks the others or the caller.
 *
 * payload: { customerId, actor:{userId,name,role}, actorType, source, description, metadata, ip, data, refs }
 *   - `data` carries structured fields used by Telegram formatting and real-time UI.
 */
export async function emitEvent(type, payload = {}) {
  const def = EVENT_CATALOG[type];
  if (!def) throw new Error(`Unknown event type: ${type}`);
  const event = { type, def, at: new Date(), source: def.category, actorType: 'system', ...payload };
  const results = await Promise.allSettled(handlers.map((h) => h(event)));
  for (const r of results) if (r.status === 'rejected') logger.error({ err: r.reason, type }, 'event handler failed');
  return event;
}

/** Fire-and-forget variant for hot paths where the caller must not wait or fail. */
export const fireEvent = (type, payload) => emitEvent(type, payload).catch((err) => logger.error({ err, type }, 'emitEvent failed'));
