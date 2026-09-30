import { processMsg91Item } from '../services/msg91/whatsapp.service.js';
import { processBrevoItem } from '../services/brevo/email.service.js';
import { processRazorpayEvent } from '../services/razorpay/payment.service.js';
import { typeOf } from '../integrations/registry.js';

/**
 * One processor per integration TYPE. Each receives a SINGLE event payload (batches are split by the receiver)
 * plus the key of the account that received it; the Webhook Center replays the same call when retrying.
 */
export const PROCESSORS_BY_TYPE = {
  msg91: processMsg91Item,
  brevo: processBrevoItem,
  razorpay: processRazorpayEvent,
};

/** Processor for an account key (msg91, brevo, brevo2, razorpay, brevo_k3f9x2, …). */
export const processorFor = (account) => PROCESSORS_BY_TYPE[typeOf(account)];

/** Backwards-compatible map keyed by the built-in account keys. */
export const PROCESSORS = {
  msg91: processMsg91Item,
  brevo: processBrevoItem,
  brevo2: processBrevoItem,
  razorpay: processRazorpayEvent,
};
