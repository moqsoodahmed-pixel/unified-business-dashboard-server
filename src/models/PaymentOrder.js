import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true }, // Razorpay order_xxx
    amount: { type: Number, required: true }, // paise
    currency: { type: String, default: 'INR' },
    receipt: String,
    status: { type: String, enum: ['created', 'attempted', 'paid'], default: 'created' },
    amountPaid: { type: Number, default: 0 },
    attempts: { type: Number, default: 0 },
    notes: mongoose.Schema.Types.Mixed,
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    paymentId: String, // successful payment
    paidAt: Date,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ receipt: 1 });

export const PaymentOrder = mongoose.model('PaymentOrder', schema);
