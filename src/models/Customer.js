import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema(
  { text: { type: String, required: true, maxlength: 4000 }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, authorName: String },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const schema = new mongoose.Schema(
  {
    firstName: { type: String, trim: true, maxlength: 100, default: '' },
    lastName: { type: String, trim: true, maxlength: 100, default: '' },
    phone: { type: String }, // normalised digits incl. country code
    email: { type: String, lowercase: true, trim: true },
    company: { type: String, trim: true, maxlength: 160 },
    tags: { type: [String], default: [] },
    notes: { type: [noteSchema], default: [] },
    source: { type: String, enum: ['WhatsApp', 'Email', 'Payment', 'Manual', 'API'], default: 'Manual' },
    status: { type: String, enum: ['lead', 'active', 'inactive', 'blocked'], default: 'active' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastInteractionAt: Date,
    possibleDuplicates: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],
  },
  { timestamps: true }
);

// One customer per phone number. Partial index so customers without a phone don't collide.
schema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
schema.index({ email: 1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ source: 1 });
schema.index({ tags: 1 });
schema.index({ lastInteractionAt: -1 });

schema.virtual('fullName').get(function fullName() {
  return [this.firstName, this.lastName].filter(Boolean).join(' ').trim();
});
schema.set('toJSON', { virtuals: true });
schema.set('toObject', { virtuals: true });

export const Customer = mongoose.model('Customer', schema);
