import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    subject: { type: String, required: true },
    htmlContent: { type: String, default: '' },
    textContent: { type: String, default: '' },
    brevoTemplateId: Number, // optional: use a template hosted in Brevo instead of local content
    variables: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export const EmailTemplate = mongoose.model('EmailTemplate', schema);
