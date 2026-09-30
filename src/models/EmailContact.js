import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: String,
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    subscribed: { type: Boolean, default: true },
    blocked: { type: Boolean, default: false }, // hard bounce / spam / block
    bounceCount: { type: Number, default: 0 },
    lastEmailedAt: Date,
  },
  { timestamps: true }
);

export const EmailContact = mongoose.model('EmailContact', schema);
