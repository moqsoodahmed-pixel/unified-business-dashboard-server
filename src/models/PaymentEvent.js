import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    eventId: String,
    type: { type: String, required: true },
    paymentId: String,
    orderId: String,
    refundId: String,
    payload: mongoose.Schema.Types.Mixed, // redacted
  },
  { timestamps: true }
);
schema.index({ paymentId: 1, createdAt: -1 });
schema.index({ orderId: 1 });
schema.index({ eventId: 1 });
schema.index({ type: 1, createdAt: -1 });

export const PaymentEvent = mongoose.model('PaymentEvent', schema);
