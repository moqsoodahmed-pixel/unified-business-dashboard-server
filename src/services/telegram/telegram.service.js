import { TelegramRoute, TelegramNotification, TelegramEvent, TelegramBot } from '../../models/index.js';
import { EVENT_CATALOG, matchesPattern, EVENT_TYPES } from '../../constants/events.js';
import { getRawCredentials, resolveAccount } from '../integration.credentials.js';
import { listAccountDefs } from '../../integrations/accounts.js';
import { isNotificationEnabled, getSection } from '../settings.service.js';
import { emitEvent } from '../event.bus.js';
import * as client from './telegram.client.js';
import { formatEvent, escapeHtml } from './formatter.js';
import { ApiError } from '../../utils/ApiError.js';
import { getPagination, pageMeta } from '../../utils/pagination.js';
import { env } from '../../config/env.js';
import { trackCall } from '../integration.service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Preset destinations offered in the UI; admins can still write any pattern list. */
export const ROUTE_PRESETS = {
  payments: { name: 'Payments', eventTypes: ['PAYMENT_*'] },
  whatsapp: { name: 'WhatsApp', eventTypes: ['WHATSAPP_*'] },
  email: { name: 'Email', eventTypes: ['EMAIL_*'] },
  system: { name: 'System', eventTypes: ['SYSTEM_*', 'DATABASE_*', 'API_*', 'INTEGRATION_*', 'HIGH_ERROR_RATE', 'WEBHOOK_FAILED'] },
  admin: { name: 'Admin', eventTypes: ['*'] },
};

function validatePatterns(patterns) {
  const ok = (p) => p === '*' || EVENT_TYPES.includes(p) || (p.endsWith('*') && EVENT_TYPES.some((t) => t.startsWith(p.slice(0, -1))));
  const bad = patterns.filter((p) => !ok(p));
  if (bad.length) throw ApiError.badRequest(`Unknown event pattern: ${bad.join(', ')}`, 'INVALID_EVENT_PATTERN');
}

export async function listRoutes() {
  return TelegramRoute.find().sort({ createdAt: 1 }).lean();
}
async function validateBot(account) {
  if (!account) return;
  if (!(await listAccountDefs('telegram')).some((a) => a.key === account)) throw ApiError.badRequest('Unknown Telegram bot', 'UNKNOWN_ACCOUNT');
}

export async function createRoute(input, user) {
  validatePatterns(input.eventTypes);
  await validateBot(input.account);
  try {
    return await TelegramRoute.create({ ...input, createdBy: user?.id });
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('A route with this name and chat already exists', 'DUPLICATE_ROUTE');
    throw err;
  }
}
export async function updateRoute(id, patch) {
  if (patch.eventTypes) validatePatterns(patch.eventTypes);
  await validateBot(patch.account);
  const r = await TelegramRoute.findByIdAndUpdate(id, patch, { new: true });
  if (!r) throw ApiError.notFound('Route not found');
  return r;
}
export async function deleteRoute(id) {
  const r = await TelegramRoute.findByIdAndDelete(id);
  if (!r) throw ApiError.notFound('Route not found');
}

/** Which enabled routes should receive this event type. */
export async function resolveRoutes(eventType) {
  const routes = await TelegramRoute.find({ enabled: true });
  return routes.filter((r) => r.eventTypes.some((p) => matchesPattern(p, eventType)));
}

async function sendWithRetry(creds, chatId, text, account = 'telegram') {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const msg = await trackCall(account, () => client.sendMessage({ chatId, text }, creds));
      return { message: msg, attempts };
    } catch (err) {
      const wait = err.retryAfter ? Math.min(err.retryAfter, 5) * 1000 : err.retriable ? 800 : 0;
      if (attempts < 2 && wait) { await sleep(wait); continue; }
      err.attempts = attempts;
      throw err;
    }
  }
}

async function deliver(route, event, text, bot) {
  try {
    if (!bot) throw Object.assign(new Error('The Telegram bot for this route is not configured'), { attempts: 0 });
    const { message, attempts } = await sendWithRetry(bot.creds, route.chatId, text, bot.key);
    await TelegramNotification.create({
      routeId: route._id, routeName: route.name, chatId: route.chatId, eventType: event.type, text, status: 'sent',
      telegramMessageId: message?.message_id, attempts, customerId: event.customerId,
    });
    await TelegramRoute.updateOne({ _id: route._id }, { lastSentAt: new Date(), lastError: null });
    await emitEvent('TELEGRAM_SENT', { source: 'telegram', description: `Telegram: ${event.type} → ${route.name}`, metadata: { route: route.name, eventType: event.type } });
    return true;
  } catch (err) {
    await TelegramNotification.create({
      routeId: route._id, routeName: route.name, chatId: route.chatId, eventType: event.type, text, status: 'failed',
      error: err.message, attempts: err.attempts || 1, customerId: event.customerId,
    });
    await TelegramRoute.updateOne({ _id: route._id }, { lastError: err.message });
    await emitEvent('TELEGRAM_FAILED', { source: 'telegram', description: `Telegram delivery to ${route.name} failed: ${err.message}`, metadata: { route: route.name, eventType: event.type } });
    return false;
  }
}

/** Entry point called by the event bus for every domain event. */
export async function notifyEvent(event) {
  const def = EVENT_CATALOG[event.type];
  if (!def?.notify) return { sent: 0 };
  if (!(await isNotificationEnabled(event.type))) return { sent: 0, reason: 'disabled' };

  const routes = await resolveRoutes(event.type);
  if (!routes.length) {
    await TelegramEvent.create({ eventType: event.type, outcome: 'no_route', summary: 'No enabled route matches this event' });
    return { sent: 0, reason: 'no_route' };
  }
  // Each route may use its own bot; resolve every bot once per event.
  const bots = new Map();
  for (const r of routes) {
    const want = r.account || '';
    if (!bots.has(want)) bots.set(want, await resolveAccount('telegram', want || undefined, { strict: false }).catch(() => null));
  }
  if (![...bots.values()].some(Boolean)) {
    await TelegramEvent.create({ eventType: event.type, outcome: 'not_configured', summary: 'Telegram is not configured' });
    return { sent: 0, reason: 'not_configured' };
  }
  const general = await getSection('general');
  const tg = await getSection('telegram');
  const text = formatEvent(event, {
    dashboardUrl: general.dashboardUrl, timezone: general.timezone, includeLink: tg.includeDashboardLinks,
    secrets: [...(await allBotTokens()), env.JWT_SECRET, env.JWT_REFRESH_SECRET, env.ENCRYPTION_KEY],
  });
  const results = await Promise.all(routes.map((r) => deliver(r, event, text, bots.get(r.account || ''))));
  const sent = results.filter(Boolean).length;
  await TelegramEvent.create({ eventType: event.type, outcome: 'dispatched', routedCount: routes.length, summary: `${sent}/${routes.length} delivered` });
  return { sent, routes: routes.length };
}

export async function sendTestToRoute(id) {
  const route = await TelegramRoute.findById(id);
  if (!route) throw ApiError.notFound('Route not found');
  const bot = await resolveAccount('telegram', route.account || undefined, { strict: false });
  const text = `🧪 <b>TEST NOTIFICATION</b>\n\nRoute: ${escapeHtml(route.name)}\nThis confirms the dashboard can reach this chat.`;
  try {
    const { message } = await sendWithRetry(bot.creds, route.chatId, text, bot.key);
    await TelegramRoute.updateOne({ _id: route._id }, { lastSentAt: new Date(), lastError: null });
    return { ok: true, messageId: message?.message_id };
  } catch (err) {
    await TelegramRoute.updateOne({ _id: route._id }, { lastError: err.message });
    throw ApiError.unprocessable(err.message, 'TELEGRAM_SEND_FAILED');
  }
}

/** Every bot token, so none of them can ever leak into a formatted message. */
async function allBotTokens() {
  const out = [];
  for (const { key } of await listAccountDefs('telegram')) {
    const { values } = await getRawCredentials(key);
    if (values.botToken) out.push(values.botToken);
  }
  return out;
}

export async function getBotInfo(account) {
  const key = !account || account === 'telegram' ? 'default' : account;
  return TelegramBot.findOne({ key }).lean();
}

/** Lets an admin find a chat id: message the bot, then list recent chats it has seen. */
export async function discoverChats(account) {
  const bot = await resolveAccount('telegram', account || undefined);
  const updates = await client.getUpdates(bot.creds);
  const seen = new Map();
  for (const u of updates || []) {
    const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (chat) seen.set(String(chat.id), { chatId: String(chat.id), title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username, type: chat.type });
  }
  return [...seen.values()];
}

export async function listNotifications(query = {}) {
  const pg = getPagination(query, { defaultLimit: 30 });
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.eventType) filter.eventType = query.eventType;
  if (query.routeId) filter.routeId = query.routeId;
  const [items, total] = await Promise.all([
    TelegramNotification.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    TelegramNotification.countDocuments(filter),
  ]);
  return { items, ...pageMeta(total, pg) };
}
