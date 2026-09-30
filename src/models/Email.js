import mongoose from 'mongoose';

const addr = new mongoose.Schema({ email: { type: String, lowercase: true }, name: String }, { _id: false });

export const EMAIL_STATUS_RANK = {
  queued: 0, sent: 1, deferred: 1, delivered: 2, opened: 3, clicked: 4,
  soft_bounced: 5, unsubscribed: 5, spam: 5, invalid: 5, blocked: 5, bounced: 6, failed: 6,
};

const schema = new mongoose.Schema(
  {
    direction: { type: String, enum: ['outbound'], default: 'outbound' },
    messageId: { type: String }, // Brevo messageId, e.g. <2026...@smtp-relay.mailin.fr>
    from: addr,
    to: { type: [addr], default: [] },
    cc: { type: [addr], default: [] },
    bcc: { type: [addr], default: [] },
    subject: { type: String, default: '' },
    htmlContent: String,
    textContent: String,
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate' },
    brevoTemplateId: Number,
    brevoAccount: { type: String, enum: ['brevo', 'brevo2'] }, // which Brevo account actually sent it
    attachments: [{ name: String, size: Number, _id: false }],
    status: { type: String, enum: Object.keys(EMAIL_STATUS_RANK), default: 'queued' },
    delivered: { type: Boolean, default: false },
    opened: { type: Boolean, default: false },
    clicked: { type: Boolean, default: false },
    bounced: { type: Boolean, default: false },
    openCount: { type: Number, default: 0 },
    clickCount: { type: Number, default: 0 },
    deliveredAt: Date,
    firstOpenedAt: Date,
    lastEventAt: Date,
    error: { code: String, message: String },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
schema.index({ messageId: 1 }, { unique: true, partialFilterExpression: { messageId: { $type: 'string' } } });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ 'to.email': 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ createdAt: -1 });

export const Email = mongoose.model('Email', schema);
