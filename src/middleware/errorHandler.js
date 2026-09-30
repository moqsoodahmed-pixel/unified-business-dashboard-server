import { ZodError } from 'zod';
import { logger } from '../config/logger.js';
import { isProd } from '../config/env.js';
import { fail } from '../utils/response.js';
import { ApiError } from '../utils/ApiError.js';
import { fireEvent } from '../services/event.bus.js';

export const notFoundHandler = (req, res) => fail(res, 404, `Route not found: ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND');

let recentServerErrors = [];
function trackErrorRate() {
  const now = Date.now();
  recentServerErrors = recentServerErrors.filter((t) => now - t < 5 * 60 * 1000);
  recentServerErrors.push(now);
  return recentServerErrors.length;
}
let lastRateAlert = 0;

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', { details: err.flatten().fieldErrors });
  }
  if (err?.type === 'entity.parse.failed') return fail(res, 400, 'Malformed JSON body', 'BAD_JSON');
  if (err?.type === 'entity.too.large') return fail(res, 413, 'Request body too large', 'PAYLOAD_TOO_LARGE');
  if (err?.name === 'CastError') return fail(res, 400, 'Invalid identifier', 'INVALID_ID');
  if (err?.code === 11000) return fail(res, 409, 'A record with those details already exists', 'DUPLICATE');
  if (err?.name === 'MulterError') return fail(res, 400, err.message, 'UPLOAD_ERROR');

  if (err instanceof ApiError) {
    const data = err.details ? { details: err.details } : null;
    if (err.status >= 500) logger.warn({ err: { message: err.message, code: err.errorCode }, path: req.path }, 'api error');
    return fail(res, err.status, err.message, err.errorCode, data);
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  const count = trackErrorRate();
  fireEvent('SYSTEM_ERROR', {
    source: 'system', description: `Unhandled error on ${req.method} ${req.path}`,
    metadata: { message: err?.message, path: req.path }, data: { where: `${req.method} ${req.path}`, error: err?.message },
  });
  if (count >= 20 && Date.now() - lastRateAlert > 15 * 60 * 1000) {
    lastRateAlert = Date.now();
    fireEvent('HIGH_ERROR_RATE', { source: 'system', description: `${count} server errors in the last 5 minutes`, data: { count } });
  }
  return fail(res, 500, isProd ? 'Something went wrong' : err?.message || 'Internal server error', 'INTERNAL_ERROR');
}
