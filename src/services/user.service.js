import { User, RefreshToken } from '../models/index.js';
import { MAX_USERS } from '../constants/permissions.js';
import { ApiError } from '../utils/ApiError.js';
import { hashPassword } from './auth.service.js';
import { emitEvent } from './event.bus.js';

const actorOf = (u) => u && { userId: u.id, name: u.name, role: u.role };

export async function listUsers() {
  const users = await User.find().sort({ createdAt: 1 });
  return users.map((u) => u.toSafe());
}

/** Only fills an empty role slot: the system always has at most one user per role, max 3 in total. */
export async function createUser(input, actor) {
  const count = await User.countDocuments();
  if (count >= MAX_USERS) throw ApiError.conflict(`This installation supports exactly ${MAX_USERS} users`, 'USER_LIMIT');
  if (await User.exists({ role: input.role })) throw ApiError.conflict(`A ${input.role} account already exists`, 'ROLE_TAKEN');
  const user = await User.create({
    name: input.name, email: input.email, username: input.username, role: input.role,
    passwordHash: await hashPassword(input.password), passwordChangedAt: new Date(),
  });
  await emitEvent('USER_UPDATED', { source: 'auth', actorType: 'user', actor: actorOf(actor), description: `User ${user.email} created (${user.role})` });
  return user.toSafe();
}

export async function updateUser(id, patch, actor) {
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  if (patch.isActive === false) {
    if (String(user._id) === actor.id) throw ApiError.badRequest('You cannot deactivate your own account', 'SELF_DEACTIVATE');
    if (user.role === 'SUPER_ADMIN') throw ApiError.badRequest('The super admin account cannot be deactivated', 'LAST_SUPER_ADMIN');
  }
  Object.assign(user, patch);
  await user.save();
  if (patch.isActive === false) await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'user-deactivated' });
  await emitEvent('USER_UPDATED', { source: 'auth', actorType: 'user', actor: actorOf(actor), description: `User ${user.email} updated`, metadata: { fields: Object.keys(patch) } });
  return user.toSafe();
}

export async function resetPassword(id, newPassword, actor) {
  const user = await User.findById(id).select('+passwordHash');
  if (!user) throw ApiError.notFound('User not found');
  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  await user.save();
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date(), revokedReason: 'password-reset' });
  await emitEvent('PASSWORD_CHANGED', { source: 'auth', actorType: 'user', actor: actorOf(actor), description: `Password reset for ${user.email} by ${actor.name}`, data: { user: user.email, ip: '' } });
}

export async function unlockUser(id, actor) {
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  user.failedLoginAttempts = 0;
  user.lockUntil = null;
  await user.save();
  await emitEvent('USER_UPDATED', { source: 'auth', actorType: 'user', actor: actorOf(actor), description: `Account ${user.email} unlocked` });
  return user.toSafe();
}
