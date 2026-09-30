import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    // Account key: a built-in key (msg91, brevo, brevo2, razorpay, telegram) or `<type>_<id>` for accounts added from the dashboard.
    provider: { type: String, required: true, unique: true, match: /^[a-z0-9_]{3,40}$/ },
    type: { type: String, enum: ['msg91', 'brevo', 'razorpay', 'telegram'] },
    label: { type: String, trim: true, maxlength: 80 }, // display name, e.g. "Brevo — Marketing"
    custom: { type: Boolean, default: false }, // true for accounts added from the dashboard
    isDefault: { type: Boolean, default: false }, // default account of its type (Razorpay, WhatsApp, Telegram)
    enabled: { type: Boolean, default: true },
    status: { type: String, enum: ['not_configured', 'untested', 'connected', 'disconnected', 'error'], default: 'untested' },
    config: { type: mongoose.Schema.Types.Mixed, default: {} }, // non-secret values
    secrets: { type: Map, of: String, default: {}, select: false }, // AES-256-GCM ciphertexts
    lastSuccessAt: Date,
    lastErrorAt: Date,
    lastError: String,
    lastTestedAt: Date,
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const Integration = mongoose.model('Integration', schema);
