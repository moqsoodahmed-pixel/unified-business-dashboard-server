import { z } from 'zod';

/**
 * Declarative description of every provider the dashboard can talk to.
 * `secret` fields are encrypted at rest and never returned by any API.
 * `mask` fields are non-secret identifiers that are still shown partially masked.
 */
const brevoFields = (prefix) => [
  { key: 'apiKey', label: 'API key', secret: true, required: true, env: `${prefix}_API_KEY`, schema: z.string().min(16).max(300) },
  { key: 'senderEmail', label: 'Default sender email', env: `${prefix}_SENDER_EMAIL`, schema: z.string().email() },
  { key: 'senderName', label: 'Default sender name', env: `${prefix}_SENDER_NAME`, schema: z.string().max(120) },
  { key: 'webhookSecret', label: 'Webhook bearer token', secret: true, env: `${prefix}_WEBHOOK_SECRET`, schema: z.string().min(16).max(200) },
];

/** The two Brevo accounts used for email sending. Account 1 keeps the original `brevo` key for backward compatibility. */
export const BREVO_ACCOUNTS = ['brevo', 'brevo2'];
export const isBrevoAccount = (p) => BREVO_ACCOUNTS.includes(p);

export const PROVIDERS = {
  msg91: {
    label: 'MSG91 WhatsApp',
    description: 'Send and receive WhatsApp messages through MSG91.',
    webhookPath: '/api/webhooks/msg91',
    fields: [
      { key: 'authKey', label: 'Auth key', secret: true, required: true, env: 'MSG91_AUTH_KEY', schema: z.string().min(8).max(200) },
      { key: 'integratedNumber', label: 'WhatsApp integrated number', required: true, env: 'MSG91_WHATSAPP_INTEGRATION_ID', schema: z.string().regex(/^\+?\d{8,15}$/, 'Digits only, with country code') },
      { key: 'templateNamespace', label: 'Template namespace', env: 'MSG91_TEMPLATE_NAMESPACE', schema: z.string().max(200) },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true, env: 'MSG91_WEBHOOK_SECRET', schema: z.string().min(16).max(200) },
    ],
  },
  brevo: {
    label: 'Brevo — Account 1',
    description: 'Email delivery and event tracking (first sending account).',
    webhookPath: '/api/webhooks/brevo',
    fields: brevoFields('BREVO'),
  },
  brevo2: {
    label: 'Brevo — Account 2',
    description: 'Email delivery and event tracking (second sending account, used together with Account 1 for blasting).',
    webhookPath: '/api/webhooks/brevo2',
    fields: brevoFields('BREVO2'),
  },
  razorpay: {
    label: 'Razorpay',
    description: 'Payment orders, checkout verification, webhooks and refunds.',
    webhookPath: '/api/webhooks/razorpay',
    fields: [
      { key: 'keyId', label: 'Key ID', required: true, mask: true, env: 'RAZORPAY_KEY_ID', schema: z.string().regex(/^rzp_(live|test)_[A-Za-z0-9]+$/, 'Expected rzp_live_… or rzp_test_…') },
      { key: 'keySecret', label: 'Key secret', secret: true, required: true, env: 'RAZORPAY_KEY_SECRET', schema: z.string().min(8).max(200) },
      { key: 'webhookSecret', label: 'Webhook secret', secret: true, env: 'RAZORPAY_WEBHOOK_SECRET', schema: z.string().min(8).max(200) },
    ],
  },
  telegram: {
    label: 'Telegram',
    description: 'Operational notifications delivered to Telegram chats.',
    fields: [
      { key: 'botToken', label: 'Bot token', secret: true, required: true, env: 'TELEGRAM_BOT_TOKEN', schema: z.string().regex(/^\d{5,}:[A-Za-z0-9_-]{20,}$/, 'Expected the format 123456:ABC-…') },
    ],
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS);
export const isProvider = (p) => PROVIDER_KEYS.includes(p);
export const secretKeys = (p) => PROVIDERS[p].fields.filter((f) => f.secret).map((f) => f.key);
