import mongoose from 'mongoose';

// Ordering used to stop out-of-order webhooks from downgrading a payment.
export const PAYMENT_STATUS_RANK = { created: 0, authorized: 1, failed: 2, captured: 3, partially_refunded: 4, refunded: 5 };

const schema = new mongoose.Schema(
  {
    paymentId: { type: String, required: true, unique: true }, // Razorpay pay_xxx
    orderId: { type: String }, // Razorpay order_xxx
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    amount: { type: Number, required: true }, // smallest currency unit (paise)
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: Object.keys(PAYMENT_STATUS_RANK), default: 'created' },
    method: String,
    methodDetails: { vpa: String, bank: String, wallet: String, cardLast4: String, cardNetwork: String },
    email: { type: String, lowercase: true },
    contact: String,
    description: String,
    notes: mongoose.Schema.Types.Mixed,
    amountRefunded: { type: Number, default: 0 },
    fee: Number,
    tax: Number,
    errorCode: String,
    errorDescription: String,
    razorpayCreatedAt: Date,
    capturedAt: Date,
    failedAt: Date,
    lastEventAt: Date,
    verifiedByClient: { type: Boolean, default: false }, // signature verified via /verify endpoint
  },
  { timestamps: true }
);
schema.index({ orderId: 1 });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ createdAt: -1 });
schema.index({ method: 1 });
schema.index({ razorpayCreatedAt: -1 });

export const Payment = mongoose.model('Payment', schema);
