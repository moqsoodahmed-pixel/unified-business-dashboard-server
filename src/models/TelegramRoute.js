import mongoose from 'mongoose';

// A destination chat plus the event patterns it receives (exact type, PREFIX_*, or *).
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    chatId: { type: String, required: true, trim: true },
    account: { type: String, default: null }, // key of the Telegram bot that sends to this chat (null = default bot)
    eventTypes: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    description: String,
    lastSentAt: Date,
    lastError: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
schema.index({ chatId: 1, name: 1 }, { unique: true });
schema.index({ enabled: 1 });

export const TelegramRoute = mongoose.model('TelegramRoute', schema);
