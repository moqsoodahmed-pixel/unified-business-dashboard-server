import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    language: { type: String, required: true, default: 'en' },
    namespace: String,
    category: { type: String, enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'OTHER'], default: 'UTILITY' },
    bodyText: { type: String, default: '' },
    variableCount: { type: Number, default: 0 }, // body_1 .. body_N
    enabled: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
schema.index({ name: 1, language: 1 }, { unique: true });

export const WhatsAppTemplate = mongoose.model('WhatsAppTemplate', schema);
