import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    provider: { type: String, required: true }, // account key that received the webhook (e.g. brevo, brevo2, brevo_k3f9x2)
    eventId: { type: String, required: true },
    eventType: String,
    payloadHash: String,
    status: { type: String, enum: ['received', 'processing', 'completed', 'failed', 'ignored', 'rejected'], default: 'received' },
    attempts: { type: Number, default: 0 },
    signatureValid: { type: Boolean, default: true },
    endpoint: String,
    payload: mongoose.Schema.Types.Mixed,
    result: String,
    error: String,
    receivedAt: { type: Date, default: Date.now },
    processedAt: Date,
    processingMs: Number,
    ip: String,
  },
  { timestamps: true }
);
// Idempotency guard: one row per provider event, enforced by the database.
schema.index({ provider: 1, eventId: 1 }, { unique: true });
schema.index({ provider: 1, receivedAt: -1 });
schema.index({ status: 1, receivedAt: -1 });
schema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

export const WebhookEvent = mongoose.model('WebhookEvent', schema);
