import { z } from 'zod';

export const passwordPolicy = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128)
  .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p), 'Include upper-case, lower-case and a number');

export const loginBody = z.object({ identifier: z.string().min(3).max(200), password: z.string().min(1).max(128) }).strict();
export const changePasswordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordPolicy }).strict();
export const userCreateBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i, 'Letters, numbers, dot, dash, underscore'),
  password: passwordPolicy,
  role: z.enum(['SUPER_ADMIN', 'ADMIN', 'OPERATOR']),
}).strict();
export const userUpdateBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  username: z.string().min(3).max(40).regex(/^[a-z0-9._-]+$/i),
  isActive: z.boolean(),
}).partial().strict();
export const resetPasswordBody = z.object({ newPassword: passwordPolicy }).strict();
