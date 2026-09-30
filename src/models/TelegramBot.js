import mongoose from 'mongoose';

// Singleton describing the bot behind the configured token (never stores the token itself).
const schema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    botId: Number,
    username: String,
    name: String,
    status: { type: String, enum: ['unknown', 'ok', 'error'], default: 'unknown' },
    lastVerifiedAt: Date,
    lastError: String,
  },
  { timestamps: true }
);

export const TelegramBot = mongoose.model('TelegramBot', schema);
