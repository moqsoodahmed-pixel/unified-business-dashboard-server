// Must be imported FIRST in every test file: config/env.js reads process.env at import time.
process.env.NODE_ENV = 'test';
process.env.ENABLE_JOBS = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789-abcdefghijklmnop';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789-abcdefghij';
process.env.ENCRYPTION_KEY = 'test-encryption-key-0123456789-abcdefgh';
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_RATE_LIMIT_MAX = '1000';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.WEBHOOK_RATE_LIMIT_MAX = '100000';
for (const k of ['MSG91_AUTH_KEY', 'MSG91_WHATSAPP_INTEGRATION_ID', 'MSG91_WEBHOOK_SECRET', 'BREVO_API_KEY', 'BREVO_SENDER_EMAIL', 'BREVO_WEBHOOK_SECRET',
  'BREVO2_API_KEY', 'BREVO2_SENDER_EMAIL', 'BREVO2_WEBHOOK_SECRET', 'BREVO_SEND_MODE',
  'BREVO_SENDER_NAME', 'BREVO2_SENDER_NAME', 'MSG91_TEMPLATE_NAMESPACE',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'TELEGRAM_BOT_TOKEN']) process.env[k] = '';
// Empty (not deleted): dotenv never overrides a variable that already exists, so real keys in a local .env
// cannot leak into the tests. The config treats empty values as unset.
process.env.BREVO_SEND_MODE = 'auto';
process.env.SUPER_ADMIN_EMAIL = 'root@example.test';
process.env.SUPER_ADMIN_PASSWORD = 'RootPass123';
process.env.ADMIN_EMAIL = 'admin@example.test';
process.env.ADMIN_PASSWORD = 'AdminPass123';
process.env.OPERATOR_EMAIL = 'operator@example.test';
process.env.OPERATOR_PASSWORD = 'OperatorPass123';
