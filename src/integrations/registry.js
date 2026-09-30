import { z } from 'zod';

/**
 * Integrations are organised as TYPES (msg91, brevo, razorpay, telegram) and ACCOUNTS.
 *
 *  - Built-in accounts (msg91, brevo, brevo2, razorpay, telegram) always exist. Their values can come from
 *    environment variables and/or from the dashboard, exactly as before.
 *  - Any number of extra accounts can be added from the Integrations page. Their key is `<type>_<id>`
 *    (e.g. `brevo_k3f9x2`), so the type of any account can be derived from its key without a database lookup.
 *
 * `secret` fields are encrypted at rest and never returned by any API.
 * `mask` fields are non-secret identifiers that are still shown partially masked.
 */
export const TYPES = {
  msg91: {
    label: 'WhatsApp (MSG91)',
    description: 'Send and receive WhatsApp messages through MSG91.',
    webhook: true,
    fields: [
      { key: 'authKey', label: 'Auth key', secret: true, required: true, schema: z.string().min(8).max(200) },
      { key: 'integratedNumber', label: 'WhatsApp integrated number', required: true, schema: z.string().regex(/^\+?\d{8,15}$/, 'Digits only, with country code') },
      { key: 'templateNamespace', label: 'Template namespace', schema: z.string().max(200) },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true, schema: z.string().min(16).max(200) },
    ],
  },
  brevo: {
    label: 'Brevo (email)',
    description: 'Email delivery and event tracking. Emails are balanced across every connected Brevo account.',
    webhook: true,
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true, schema: z.string().min(16).max(300) },
      { key: 'senderEmail', label: 'Sender email', schema: z.string().email() },
      { key: 'senderName', label: 'Sender name', schema: z.string().max(120) },
      { key: 'webhookSecret', label: 'Webhook bearer token', secret: true, schema: z.string().min(16).max(200) },
    ],
  },
  razorpay: {
    label: 'Razorpay',
    description: 'Payment orders, checkout verification, webhooks and refunds.',
    webhook: true,
    fields: [
      { key: 'keyId', label: 'Key ID', required: true, mask: true, schema: z.string().regex(/^rzp_(live|test)_[A-Za-z0-9]+$/, 'Expected rzp_live_… or rzp_test_…') },
      { key: 'keySecret', label: 'Key secret', secret: true, required: true, schema: z.string().min(8).max(200) },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true, schema: z.string().min(8).max(200) },
    ],
  },
  telegram: {
    label: 'Telegram',
    description: 'Operational notifications delivered to Telegram chats.',
    webhook: false,
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, required: true, schema: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{20,}$/, 'Expected the format 123456:ABC-…') },
    ],
  },
};
export const TYPE_KEYS = Object.keys(TYPES);
export const isType = (t) => TYPE_KEYS.includes(t);

const withEnv = (type, env) => TYPES[type].fields.map((f) => ({ ...f, env: env[f.key] }));
const brevoEnv = (p) => ({ apiKey: `${p}_API_KEY`, senderEmail: `${p}_SENDER_EMAIL`, senderName: `${p}_SENDER_NAME`, webhookSecret: `${p}_WEBHOOK_SECRET` });

/** Accounts that always exist and may be configured from environment variables. */
export const PROVIDERS = {
  msg91: {
    type: 'msg91', label: 'WhatsApp (MSG91)', description: TYPES.msg91.description, webhookPath: '/api/webhooks/msg91',
    fields: withEnv('msg91', { authKey: 'MSG91_AUTH_KEY', integratedNumber: 'MSG91_WHATSAPP_INTEGRATION_ID', templateNamespace: 'MSG91_TEMPLATE_NAMESPACE', webhookSecret: 'MSG91_WEBHOOK_SECRET' }),
  },
  brevo: { type: 'brevo', label: 'Brevo — Account 1', description: TYPES.brevo.description, webhookPath: '/api/webhooks/brevo', fields: withEnv('brevo', brevoEnv('BREVO')) },
  brevo2: { type: 'brevo', label: 'Brevo — Account 2', description: TYPES.brevo.description, webhookPath: '/api/webhooks/brevo2', fields: withEnv('brevo', brevoEnv('BREVO2')) },
  razorpay: {
    type: 'razorpay', label: 'Razorpay', description: TYPES.razorpay.description, webhookPath: '/api/webhooks/razorpay',
    fields: withEnv('razorpay', { keyId: 'RAZORPAY_KEY_ID', keySecret: 'RAZORPAY_KEY_SECRET', webhookSecret: 'RAZORPAY_WEBHOOK_SECRET' }),
  },
  telegram: { type: 'telegram', label: 'Telegram', description: TYPES.telegram.description, fields: withEnv('telegram', { botToken: 'TELEGRAM_BOT_TOKEN' }) },
};
export const PROVIDER_KEYS = Object.keys(PROVIDERS);
export const isBuiltin = (key) => PROVIDER_KEYS.includes(key);

/** Custom account keys: `<type>_<4-16 lowercase letters/digits>`. */
export const CUSTOM_KEY_RX = new RegExp(`^(${TYPE_KEYS.join('|')})_[a-z0-9]{4,16}$`);
export const ACCOUNT_KEY_RX = new RegExp(`^(${PROVIDER_KEYS.join('|')}|(${TYPE_KEYS.join('|')})_[a-z0-9]{4,16})$`);
export const isAccountKey = (key) => typeof key === 'string' && ACCOUNT_KEY_RX.test(key);

/** Type of any account key (built-in or custom), or null. Synchronous: the type is encoded in the key. */
export function typeOf(key) {
  if (PROVIDERS[key]) return PROVIDERS[key].type;
  if (typeof key === 'string' && CUSTOM_KEY_RX.test(key)) return key.split('_')[0];
  return null;
}

/** Field definitions for any account key (env mapping only exists for built-in accounts). */
export const fieldsOf = (key) => PROVIDERS[key]?.fields || TYPES[typeOf(key)]?.fields || [];

/** Kept for existing callers: true for any valid account key. */
export const isProvider = (p) => isAccountKey(p);
export const secretKeys = (p) => fieldsOf(p).filter((f) => f.secret).map((f) => f.key);
