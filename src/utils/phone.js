import { env } from '../config/env.js';

/**
 * Normalise a phone number to digits with country code (no "+"), e.g. "919876543210".
 * Returns null when it can't be normalised confidently.
 */
export function normalizePhone(input, defaultCc = env.DEFAULT_COUNTRY_CODE) {
  if (input === undefined || input === null) return null;
  let d = String(input).replace(/[^\d]/g, '');
  if (!d) return null;
  if (String(input).trim().startsWith('00')) d = d.replace(/^00/, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = defaultCc + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

export const normalizeEmail = (input) => {
  if (!input) return null;
  const e = String(input).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

export const displayPhone = (p) => (p ? `+${p}` : '');
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
