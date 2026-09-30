import 'dotenv/config';
import { z } from 'zod';

const bool = (def) =>
  z.preprocess((v) => (v === undefined || v === '' ? def : String(v).toLowerCase() === 'true'), z.boolean());
// A blank `KEY=` line in .env arrives as '' and would skip .default(); treat blank as unset.
const secret = (def) => z.preprocess((v) => (v === undefined || String(v).trim() === '' ? undefined : v), z.string().default(def));
const opt = z.string().optional().transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/unified_dashboard'),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: opt,
  TRUST_PROXY: z.coerce.number().default(0),

  JWT_SECRET: secret('dev-only-jwt-secret-change-me-please-32chars'),
  JWT_REFRESH_SECRET: secret('dev-only-refresh-secret-change-me-32chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(7),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: opt,
  ENCRYPTION_KEY: secret('dev-only-encryption-key-change-me'),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().default(15),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().default(20),
  API_RATE_LIMIT_MAX: z.coerce.number().default(600),
  WEBHOOK_RATE_LIMIT_MAX: z.coerce.number().default(600),

  MSG91_AUTH_KEY: opt,
  MSG91_WHATSAPP_INTEGRATION_ID: opt,
  MSG91_TEMPLATE_NAMESPACE: opt,
  MSG91_WEBHOOK_SECRET: opt,

  BREVO_API_KEY: opt,
  BREVO_SENDER_EMAIL: opt,
  BREVO_SENDER_NAME: opt,
  BREVO_WEBHOOK_SECRET: opt,

  // Second Brevo account (used for email blasting together with account 1)
  BREVO2_API_KEY: opt,
  BREVO2_SENDER_EMAIL: opt,
  BREVO2_SENDER_NAME: opt,
  BREVO2_WEBHOOK_SECRET: opt,
  // How a send is routed when the sender does not pick an account: auto (least used in the last 24h, with failover) | 1 | 2
  BREVO_SEND_MODE: z.enum(['auto', '1', '2']).default('auto'),

  RAZORPAY_KEY_ID: opt,
  RAZORPAY_KEY_SECRET: opt,
  RAZORPAY_WEBHOOK_SECRET: opt,

  TELEGRAM_BOT_TOKEN: opt,

  DEFAULT_COUNTRY_CODE: z.string().default('91'),
  TIMEZONE: z.string().default('Asia/Kolkata'),
  LARGE_PAYMENT_THRESHOLD: z.coerce.number().default(100000), // major currency units (rupees)

  ENABLE_MOCK_DATA: bool(false),
  ALLOW_UNSIGNED_WEBHOOKS: bool(false),
  LOG_LEVEL: z.string().default('info'),
  ENABLE_JOBS: bool(true),

  SUPER_ADMIN_EMAIL: opt,
  SUPER_ADMIN_PASSWORD: opt,
  SUPER_ADMIN_NAME: opt,
  ADMIN_EMAIL: opt,
  ADMIN_PASSWORD: opt,
  ADMIN_NAME: opt,
  OPERATOR_EMAIL: opt,
  OPERATOR_PASSWORD: opt,
  OPERATOR_NAME: opt,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

const DEV_DEFAULTS = ['dev-only-jwt-secret', 'dev-only-refresh-secret', 'dev-only-encryption-key'];

/** Refuse to boot in production with weak or default secrets. */
export function assertProductionConfig() {
  if (!isProd) return;
  const problems = [];
  for (const k of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']) {
    const v = env[k];
    if (DEV_DEFAULTS.some((d) => v.startsWith(d))) problems.push(`${k} is still the development default`);
    else if (v.length < 32) problems.push(`${k} must be at least 32 characters`);
  }
  if (env.ENABLE_MOCK_DATA) problems.push('ENABLE_MOCK_DATA must be false in production');
  if (env.ALLOW_UNSIGNED_WEBHOOKS) problems.push('ALLOW_UNSIGNED_WEBHOOKS must be false in production');
  if (problems.length) {
    console.error('Refusing to start in production:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
}

export const apiBaseUrl = () => (env.PUBLIC_API_URL || `http://localhost:${env.PORT}`).replace(/\/$/, '');
