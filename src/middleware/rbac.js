import { ApiError } from '../utils/ApiError.js';
import { ROLES } from '../constants/permissions.js';

/** Require ALL listed permissions. */
export const requirePermission = (...perms) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  const missing = perms.filter((p) => !req.user.permissions.includes(p));
  if (missing.length) return next(ApiError.forbidden('You do not have permission to do that', 'FORBIDDEN'));
  next();
};

/** Require ANY of the listed permissions. */
export const requireAnyPermission = (...perms) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!perms.some((p) => req.user.permissions.includes(p))) return next(ApiError.forbidden());
  next();
};

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (!roles.includes(req.user.role)) return next(ApiError.forbidden());
  next();
};

export const superAdminOnly = requireRole(ROLES.SUPER_ADMIN);
