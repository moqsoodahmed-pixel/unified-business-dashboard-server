import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { User, RefreshToken } from '../models/index.js';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { randomToken, sha256 } from '../utils/crypto.js';
import { permissionsFor } from '../constants/permissions.js';
import { emitEvent } from './event.bus.js';

const BCRYPT_ROUNDS = 12;
const REUSE_GRACE_MS = 10_000;
// Pre-computed hash so unknown-user logins cost the same as real ones (blunts user enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

export const hashPassword = (p) => bcrypt.hash(p, BCRYPT_ROUNDS);
const actorOf = (u) => ({ userId: u._id, name: u.name, role: u.role });

export function signAccessToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: env.ACCESS_TOKEN_TTL });
}

async function issueRefreshToken(user, ctx, family = crypto.randomUUID()) {
  const raw = randomToken(48);
  const doc = await RefreshToken.create({
    user: user._id, tokenHash: sha256(raw), family,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400000),
    ip: ctx.ip, userAgent: (ctx.userAgent || '').slice(0, 300), lastUsedAt: new Date(),
  });
  return { raw, doc };
}

export const publicUser = (u) => ({
  id: String(u._id), name: u.name, email: u.email, username: u.username, role: u.role, permissions: permissionsFor(u.role),
});

export async function login({ identifier, password }, ctx) {
  const id = identifier.trim().toLowerCase();
  const user = await User.findOne({ $or: [{ email: id }, { username: id }] }).select('+passwordHash');

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await emitEvent('FAILED_LOGIN', { source: 'auth', ip: ctx.ip, description: 'Failed login for unknown account', metadata: { identifier: id.slice(0, 3) + '***' }, data: { reason: 'Unknown account', ip: ctx.ip } });
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }
  if (!user.isActive) throw ApiError.unauthorized('Account is disabled', 'ACCOUNT_DISABLED');
  if (user.lockUntil && user.lockUntil > new Date()) {
    throw new ApiError(423, `Account locked. Try again after ${user.lockUntil.toISOString()}`, 'ACCOUNT_LOCKED');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    user.failedLoginAttempts += 1;
    let locked = false;
    if (user.failedLoginAttempts >= env.LOGIN_MAX_ATTEMPTS) {
      user.lockUntil = new Date(Date.now() + env.LOGIN_LOCK_MINUTES * 60000);
      user.failedLoginAttempts = 0;
      locked = true;
    }
    await user.save();
    await emitEvent('FAILED_LOGIN', { source: 'auth', ip: ctx.ip, actorType: 'user', actor: actorOf(user), description: `Failed login for ${user.email}`, data: { user: user.email, ip: ctx.ip, attempts: user.failedLoginAttempts } });
    if (locked) await emitEvent('ACCOUNT_LOCKED', { source: 'auth', ip: ctx.ip, actor: actorOf(user), description: `Account ${user.email} locked after repeated failures`, data: { user: user.email, minutes: env.LOGIN_LOCK_MINUTES } });
    throw ApiError.unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
  }

  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  user.lastLoginAt = new Date();
  user.lastLoginIp = ctx.ip;
  await user.save();

  const { raw } = await issueRefreshToken(user, ctx);
  await emitEvent('USER_LOGIN', { source: 'auth', actorType: 'user', actor: actorOf(user), ip: ctx.ip, description: `${user.name} signed in`, data: { user: user.name, role: user.role, ip: ctx.ip } });
  return { accessToken: signAccessToken(user), refreshToken: raw, user: publicUser(user) };
}

/** Rotate a refresh token. Presenting an already-rotated token revokes the whole session family. */
export async function refresh(rawToken, ctx) {
  if (!rawToken) throw ApiError.unauthorized('Missing refresh token', 'NO_REFRESH_TOKEN');
  const doc = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
  if (!doc) throw ApiError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');

  if (doc.revokedAt) {
    const withinGrace = doc.revokedReason === 'rotated' && Date.now() - doc.revokedAt.getTime() < REUSE_GRACE_MS;
    if (withinGrace) throw ApiError.unauthorized('Refresh already in progress', 'REFRESH_RACE');
    await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'reuse-detected' });
    const u = await User.findById(doc.user);
    await emitEvent('SESSION_REUSE_DETECTED', { source: 'auth', ip: ctx.ip, actor: u && actorOf(u), description: 'A rotated refresh token was reused; session revoked', data: { user: u?.email, ip: ctx.ip } });
    throw ApiError.unauthorized('Session revoked', 'REFRESH_REUSE');
  }
  if (doc.expiresAt < new Date()) throw ApiError.unauthorized('Refresh token expired', 'REFRESH_EXPIRED');

  const user = await User.findById(doc.user);
  if (!user || !user.isActive) throw ApiError.unauthorized('Account is disabled', 'ACCOUNT_DISABLED');

  const next = await issueRefreshToken(user, ctx, doc.family);
  doc.revokedAt = new Date();
  doc.revokedReason = 'rotated';
  doc.replacedBy = next.doc._id;
  await doc.save();
  return { accessToken: signAccessToken(user), refreshToken: next.raw, user: publicUser(user) };
}

export async function logout(rawToken, user, ctx) {
  if (rawToken) {
    const doc = await RefreshToken.findOne({ tokenHash: sha256(rawToken) });
    if (doc) await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'logout' });
  }
  if (user) await emitEvent('USER_LOGOUT', { source: 'auth', actorType: 'user', actor: { userId: user.id, name: user.name, role: user.role }, ip: ctx.ip, description: `${user.name} signed out` });
}

export async function changePassword(userId, { currentPassword, newPassword }, ctx) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw ApiError.badRequest('Current password is incorrect', 'WRONG_PASSWORD');
  if (await bcrypt.compare(newPassword, user.passwordHash)) throw ApiError.badRequest('Choose a password you have not used before', 'PASSWORD_REUSED');
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'password-change' });
  await emitEvent('PASSWORD_CHANGED', { source: 'auth', actorType: 'user', actor: actorOf(user), ip: ctx.ip, description: `${user.name} changed their password`, data: { user: user.name, ip: ctx.ip } });
}

export async function listSessions(userId, currentRaw) {
  const currentHash = currentRaw ? sha256(currentRaw) : null;
  const docs = await RefreshToken.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean();
  return docs.map((d) => ({
    id: String(d._id), family: d.family, ip: d.ip, userAgent: d.userAgent, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt,
    current: currentHash === d.tokenHash,
  }));
}

export async function revokeSession(userId, sessionId) {
  const doc = await RefreshToken.findOne({ _id: sessionId, user: userId });
  if (!doc) throw ApiError.notFound('Session not found');
  await RefreshToken.updateMany({ family: doc.family, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'revoked-by-user' });
}

export async function revokeAllSessions(userId, exceptRaw) {
  const keep = exceptRaw ? await RefreshToken.findOne({ tokenHash: sha256(exceptRaw) }) : null;
  const filter = { user: userId, revokedAt: null, ...(keep ? { family: { $ne: keep.family } } : {}) };
  await RefreshToken.updateMany(filter, { revokedAt: new Date(), revokedReason: 'revoked-all' });
}
