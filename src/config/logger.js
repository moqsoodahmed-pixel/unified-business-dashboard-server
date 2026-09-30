import { createRequire } from 'node:module';
import pino from 'pino';
import { env, isProd, isTest } from './env.js';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'req.headers["x-webhook-secret"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.authKey',
  '*.keySecret',
  '*.botToken',
  '*.webhookSecret',
];

/** pino-pretty is a devDependency: only use it when it is actually installed (never in production images). */
const hasPrettyLogger = () => {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
};

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  ...(isProd || isTest || !hasPrettyLogger()
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});
