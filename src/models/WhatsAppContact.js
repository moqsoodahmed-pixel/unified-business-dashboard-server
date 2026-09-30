import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    profileName: String,
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    optedIn: { type: Boolean, default: true },
    lastSeenAt: Date,
  },
  { timestamps: true }
);

export const WhatsAppContact = mongoose.model('WhatsAppContact', schema);
