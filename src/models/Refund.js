import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    refundId: { type: String, required: true, unique: true }, // Razorpay rfnd_xxx
    paymentId: { type: String, required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
    speed: String,
    reason: String,
    notes: mongoose.Schema.Types.Mixed,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    processedAt: Date,
  },
  { timestamps: true }
);
schema.index({ status: 1, createdAt: -1 });

export const Refund = mongoose.model('Refund', schema);
