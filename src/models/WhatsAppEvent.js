import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    type: { type: String, enum: ['inbound', 'status', 'template', 'unknown'], required: true },
    status: String,
    providerMessageId: String,
    phone: String,
    messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppMessage' },
    payload: mongoose.Schema.Types.Mixed, // redacted provider payload
    matched: { type: Boolean, default: false },
  },
  { timestamps: true }
);
schema.index({ providerMessageId: 1, createdAt: -1 });
schema.index({ type: 1, createdAt: -1 });
schema.index({ createdAt: -1 });

export const WhatsAppEvent = mongoose.model('WhatsAppEvent', schema);
