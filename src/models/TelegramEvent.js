import mongoose from 'mongoose';

// Every domain event the notifier evaluated, and what happened to it.
const schema = new mongoose.Schema(
  {
    eventType: { type: String, required: true },
    outcome: { type: String, enum: ['dispatched', 'no_route', 'disabled', 'not_configured', 'not_notifiable'], required: true },
    routedCount: { type: Number, default: 0 },
    summary: String,
  },
  { timestamps: true }
);
schema.index({ createdAt: -1 });
schema.index({ eventType: 1, createdAt: -1 });
schema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const TelegramEvent = mongoose.model('TelegramEvent', schema);
