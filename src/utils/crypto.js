import crypto from 'node:crypto';
import { env } from '../config/env.js';

const key = () => crypto.createHash('sha256').update(String(env.ENCRYPTION_KEY)).digest();

/** AES-256-GCM. Output format: v1:<iv>:<tag>:<ciphertext> (all base64url). */
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(':');
}

export function decrypt(payload) {
  const [v, iv, tag, data] = String(payload).split(':');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export const sha256 = (input) => crypto.createHash('sha256').update(input).digest('hex');
export const hmacSha256Hex = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url');

/** Constant-time string comparison that tolerates different lengths. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab); // keep timing roughly constant
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}
