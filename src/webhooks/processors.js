import { processMsg91Item } from '../services/msg91/whatsapp.service.js';
import { processBrevoItem } from '../services/brevo/email.service.js';
import { processRazorpayEvent } from '../services/razorpay/payment.service.js';

/**
 * One processor per provider. Each receives a SINGLE event payload (batches are split by the receiver),
 * which is also what the Webhook Center replays when an operator retries a failed event.
 */
export const PROCESSORS = {
  msg91: processMsg91Item,
  brevo: processBrevoItem,
  brevo2: processBrevoItem,
  razorpay: processRazorpayEvent,
};
