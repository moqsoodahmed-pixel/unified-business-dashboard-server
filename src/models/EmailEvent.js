import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    emailId: { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
    messageId: String,
    event: { type: String, required: true },
    recipient: String,
    reason: String,
    link: String,
    occurredAt: Date,
    payload: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true }
);
schema.index({ emailId: 1, occurredAt: 1 });
schema.index({ messageId: 1 });
schema.index({ event: 1, createdAt: -1 });

export const EmailEvent = mongoose.model('EmailEvent', schema);
