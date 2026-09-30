import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { probeProviders } from '../services/health.service.js';

const timers = [];
const every = (name, ms, fn) => {
  const t = setInterval(() => fn().catch((err) => logger.warn({ err: err.message, job: name }, 'job failed')), ms);
  t.unref();
  timers.push(t);
};

export function startJobs() {
  if (!env.ENABLE_JOBS) return;
  // Keeps provider status on the Integrations page honest between manual tests.
  every('provider-probe', 10 * 60 * 1000, probeProviders);
  logger.info('background jobs started');
}
export const stopJobs = () => timers.forEach(clearInterval);
