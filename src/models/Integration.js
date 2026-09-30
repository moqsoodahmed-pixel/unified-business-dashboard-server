import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    provider: { type: String, enum: ['msg91', 'brevo', 'brevo2', 'razorpay', 'telegram'], required: true, unique: true },
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
