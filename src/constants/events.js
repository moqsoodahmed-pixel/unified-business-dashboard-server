/**
 * Single catalog of domain events. Drives the activity log, Telegram routing,
 * notification toggles and real-time UI alerts.
 *  - activity : write an ActivityLog row
 *  - notify   : eligible for Telegram notification
 *  - defaultOn: default state of the notification toggle
 */
const e = (category, label, severity, { activity = true, notify = true, defaultOn = true, emoji = 'ℹ️' } = {}) => ({
  category, label, severity, activity, notify, defaultOn, emoji,
});

export const EVENT_CATALOG = Object.freeze({
  WHATSAPP_RECEIVED: e('whatsapp', 'New WhatsApp message', 'info', { emoji: '💬' }),
  WHATSAPP_SENT: e('whatsapp', 'WhatsApp message sent', 'info', { defaultOn: false, emoji: '📤' }),
  WHATSAPP_DELIVERED: e('whatsapp', 'WhatsApp message delivered', 'info', { activity: false, defaultOn: false, emoji: '✅' }),
  WHATSAPP_READ: e('whatsapp', 'WhatsApp message read', 'info', { activity: false, defaultOn: false, emoji: '👀' }),
  WHATSAPP_FAILED: e('whatsapp', 'WhatsApp message failed', 'error', { emoji: '⚠️' }),

  EMAIL_SENT: e('email', 'Email sent', 'info', { defaultOn: false, emoji: '📧' }),
  EMAIL_DELIVERED: e('email', 'Email delivered', 'success', { defaultOn: false, emoji: '📬' }),
  EMAIL_FAILED: e('email', 'Email failed', 'error', { emoji: '❌' }),
  EMAIL_BOUNCED: e('email', 'Email bounced', 'warning', { emoji: '↩️' }),

  PAYMENT_CREATED: e('payment', 'Payment order created', 'info', { defaultOn: false, emoji: '🧾' }),
  PAYMENT_SUCCESS: e('payment', 'Payment successful', 'success', { emoji: '💰' }),
  PAYMENT_FAILED: e('payment', 'Payment failed', 'error', { emoji: '🚫' }),
  PAYMENT_REFUNDED: e('payment', 'Refund created', 'warning', { emoji: '💸' }),
  PAYMENT_LARGE: e('payment', 'Large payment received', 'success', { activity: false, emoji: '🏦' }),
  PAYMENT_WEBHOOK_FAILED: e('payment', 'Payment webhook failure', 'error', { activity: false, emoji: '🛑' }),

  TELEGRAM_SENT: e('telegram', 'Telegram notification sent', 'info', { notify: false }),
  TELEGRAM_FAILED: e('telegram', 'Telegram notification failed', 'warning', { notify: false }),

  CUSTOMER_CREATED: e('customer', 'New customer', 'info', { emoji: '🆕' }),
  CUSTOMER_UPDATED: e('customer', 'Customer updated', 'info', { defaultOn: false, emoji: '✏️' }),

  USER_LOGIN: e('auth', 'User login', 'info', { emoji: '🔐' }),
  USER_LOGOUT: e('auth', 'User logout', 'info', { notify: false }),
  FAILED_LOGIN: e('auth', 'Failed login', 'warning', { emoji: '🚨' }),
  ACCOUNT_LOCKED: e('auth', 'Account locked', 'error', { emoji: '🔒' }),
  PASSWORD_CHANGED: e('auth', 'Password changed', 'warning', { emoji: '🔑' }),
  SESSION_REUSE_DETECTED: e('auth', 'Refresh token reuse detected', 'error', { emoji: '🛡️' }),
  USER_UPDATED: e('auth', 'User account updated', 'info', { defaultOn: false }),

  WEBHOOK_RECEIVED: e('webhook', 'Webhook received', 'info', { notify: false }),
  WEBHOOK_FAILED: e('webhook', 'Webhook processing failed', 'error', { emoji: '🛑' }),

  SYSTEM_ERROR: e('system', 'System error', 'error', { emoji: '🔥' }),
  DATABASE_ERROR: e('system', 'Database error', 'error', { emoji: '🗄️' }),
  API_FAILURE: e('system', 'Provider API failure', 'error', { emoji: '🔌' }),
  INTEGRATION_DISCONNECTED: e('system', 'Integration disconnected', 'error', { emoji: '🔌' }),
  HIGH_ERROR_RATE: e('system', 'High error rate', 'error', { emoji: '📈' }),
  SETTINGS_CHANGED: e('system', 'Settings changed', 'info', { notify: false }),
});

export const EVENT_TYPES = Object.keys(EVENT_CATALOG);
export const EVENT_CATEGORIES = ['whatsapp', 'email', 'payment', 'telegram', 'customer', 'auth', 'webhook', 'system'];

/** Route patterns: exact type, `PREFIX_*`, or `*`. */
export function matchesPattern(pattern, eventType) {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return eventType.startsWith(pattern.slice(0, -1));
  return pattern === eventType;
}
