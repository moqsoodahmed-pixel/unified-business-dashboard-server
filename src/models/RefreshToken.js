import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
    replacedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'RefreshToken' },
    ip: String,
    userAgent: String,
    lastUsedAt: Date,
  },
  { timestamps: true }
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // purge a day after expiry

export const RefreshToken = mongoose.model('RefreshToken', schema);
