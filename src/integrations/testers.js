import * as msg91 from '../services/msg91/msg91.client.js';
import * as brevo from '../services/brevo/brevo.client.js';
import * as razorpay from '../services/razorpay/razorpay.client.js';
import * as telegram from '../services/telegram/telegram.client.js';
import { TelegramBot } from '../models/index.js';

/**
 * One tester per integration TYPE. Each takes explicit credentials (and the account key) and throws on failure.
 * Returned details are safe to display.
 */
export const testers = {
  async msg91(creds) {
    await msg91.listTemplates(creds, { pagination: false });
    return { integratedNumber: creds.integratedNumber };
  },
  async brevo(creds) {
    const a = await brevo.getAccount(creds);
    return { account: a?.companyName || a?.email || 'Brevo account', plan: a?.plan?.[0]?.type };
  },
  async razorpay(creds) {
    await razorpay.ping(creds);
    return { mode: creds.keyId.startsWith('rzp_live_') ? 'live' : 'test' };
  },
  async telegram(creds, account = 'telegram') {
    const me = await telegram.getMe(creds);
    await TelegramBot.findOneAndUpdate(
      { key: account === 'telegram' ? 'default' : account },
      { botId: me.id, username: me.username, name: me.first_name, status: 'ok', lastVerifiedAt: new Date(), lastError: null },
      { upsert: true }
    );
    return { bot: `@${me.username}` };
  },
};
