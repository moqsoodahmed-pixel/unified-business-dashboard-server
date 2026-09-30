export const ROLES = Object.freeze({ SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', OPERATOR: 'OPERATOR' });
export const ROLE_LIST = Object.values(ROLES);
export const MAX_USERS = 3;

export const ALL_PERMISSIONS = [
  'dashboard:read',
  'customers:read', 'customers:write',
  'whatsapp:read', 'whatsapp:write',
  'email:read', 'email:send', 'email:manage',
  'payments:read', 'payments:write', 'payments:refund',
  'telegram:read', 'telegram:write', 'telegram:configure',
  'notifications:read', 'notifications:write',
  'activity:read',
  'reports:read',
  'integrations:read', 'integrations:write',
  'webhooks:read', 'webhooks:retry',
  'users:read', 'users:write',
  'settings:read', 'settings:write',
  'health:read',
  'search:read',
];

const ADMIN = [
  'dashboard:read',
  'customers:read', 'customers:write',
  'whatsapp:read', 'whatsapp:write',
  'email:read', 'email:send', 'email:manage',
  'payments:read', 'payments:write', 'payments:refund',
  'telegram:read', 'telegram:write',
  'notifications:read', 'notifications:write',
  'activity:read',
  'reports:read',
  'integrations:read',
  'webhooks:read', 'webhooks:retry',
  'settings:read',
  'health:read',
  'search:read',
];

const OPERATOR = [
  'dashboard:read',
  'customers:read', 'customers:write',
  'whatsapp:read', 'whatsapp:write',
  'email:read', 'email:send',
  'payments:read',
  'notifications:read',
  'activity:read',
  'search:read',
];

export const ROLE_PERMISSIONS = Object.freeze({ SUPER_ADMIN: ALL_PERMISSIONS, ADMIN, OPERATOR });
export const permissionsFor = (role) => ROLE_PERMISSIONS[role] || [];
export const can = (role, permission) => permissionsFor(role).includes(permission);
