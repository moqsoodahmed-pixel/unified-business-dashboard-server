import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramRoute' },
    routeName: String,
    chatId: String,
    eventType: { type: String, required: true },
    text: String,
    status: { type: String, enum: ['sent', 'failed'], required: true },
    telegramMessageId: Number,
    error: String,
    attempts: { type: Number, default: 1 },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  },
  { timestamps: true }
);
schema.index({ createdAt: -1 });
schema.index({ eventType: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ routeId: 1, createdAt: -1 });

export const TelegramNotification = mongoose.model('TelegramNotification', schema);
