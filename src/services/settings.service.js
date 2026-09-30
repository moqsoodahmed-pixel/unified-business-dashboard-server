import { z } from 'zod';
import { SystemSetting } from '../models/index.js';
import { EVENT_CATALOG } from '../constants/events.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

const DEFAULTS = {
  general: { companyName: 'My Business', timezone: env.TIMEZONE, dashboardUrl: env.CLIENT_URL },
  whatsapp: { autoAssignToFirstReplier: true, sessionWindowHours: 24 },
  email: { defaultSenderName: '', defaultSenderEmail: '', replyToEmail: '' },
  payments: { defaultCurrency: 'INR', largePaymentThreshold: env.LARGE_PAYMENT_THRESHOLD },
  telegram: { includeDashboardLinks: true },
  security: { maxLoginAttempts: env.LOGIN_MAX_ATTEMPTS, lockMinutes: env.LOGIN_LOCK_MINUTES, accessTokenTtl: env.ACCESS_TOKEN_TTL, refreshTokenDays: env.REFRESH_TOKEN_TTL_DAYS },
};

const SCHEMAS = {
  general: z.object({ companyName: z.string().min(1).max(120), timezone: z.string().min(1).max(60), dashboardUrl: z.string().url() }).partial().strict(),
  whatsapp: z.object({ autoAssignToFirstReplier: z.boolean() }).partial().strict(),
  email: z.object({ defaultSenderName: z.string().max(120), defaultSenderEmail: z.string().email().or(z.literal('')), replyToEmail: z.string().email().or(z.literal('')) }).partial().strict(),
  payments: z.object({ defaultCurrency: z.string().length(3), largePaymentThreshold: z.number().min(0) }).partial().strict(),
  telegram: z.object({ includeDashboardLinks: z.boolean() }).partial().strict(),
};
// `security` is deliberately read-only from the UI: it reflects env-configured policy.
export const EDITABLE_SECTIONS = Object.keys(SCHEMAS);

export async function getSection(section) {
  if (!(section in DEFAULTS)) throw ApiError.notFound('Unknown settings section');
  const doc = await SystemSetting.findOne({ key: `section:${section}` }).lean();
  return { ...DEFAULTS[section], ...(doc?.value || {}) };
}

export async function updateSection(section, values, userId) {
  if (!EDITABLE_SECTIONS.includes(section)) throw ApiError.badRequest('This settings section is read-only', 'READ_ONLY');
  const parsed = SCHEMAS[section].safeParse(values);
  if (!parsed.success) throw ApiError.badRequest('Invalid settings', 'VALIDATION_ERROR', parsed.error.flatten().fieldErrors);
  const current = await getSection(section);
  const next = { ...current, ...parsed.data };
  await SystemSetting.findOneAndUpdate({ key: `section:${section}` }, { value: next, updatedBy: userId }, { upsert: true, new: true });
  return next;
}

export async function getAllSections() {
  const out = {};
  for (const s of Object.keys(DEFAULTS)) out[s] = await getSection(s);
  return out;
}

/* ---------------- notification toggles ---------------- */

export async function getNotificationToggles() {
  const doc = await SystemSetting.findOne({ key: 'notifications' }).lean();
  const overrides = doc?.value || {};
  const out = {};
  for (const [type, def] of Object.entries(EVENT_CATALOG)) {
    if (!def.notify) continue;
    out[type] = typeof overrides[type] === 'boolean' ? overrides[type] : def.defaultOn;
  }
  return out;
}

export async function updateNotificationToggles(patch, userId) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (EVENT_CATALOG[k]?.notify && typeof v === 'boolean') clean[k] = v;
  }
  const doc = await SystemSetting.findOne({ key: 'notifications' }).lean();
  const value = { ...(doc?.value || {}), ...clean };
  await SystemSetting.findOneAndUpdate({ key: 'notifications' }, { value, updatedBy: userId }, { upsert: true });
  return getNotificationToggles();
}

export async function isNotificationEnabled(type) {
  const def = EVENT_CATALOG[type];
  if (!def?.notify) return false;
  const doc = await SystemSetting.findOne({ key: 'notifications' }).lean();
  const v = doc?.value?.[type];
  return typeof v === 'boolean' ? v : def.defaultOn;
}
