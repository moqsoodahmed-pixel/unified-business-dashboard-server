import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const json = (message, errorCode = 'RATE_LIMITED') => (_req, res) =>
  res.status(429).json({ success: false, message, errorCode, data: null });

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: env.LOGIN_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
  handler: json('Too many login attempts. Try again later.'),
});

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, limit: env.API_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
  handler: json('Too many requests. Slow down.'),
});

export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, limit: env.WEBHOOK_RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false,
  handler: json('Too many webhook requests.'),
});
