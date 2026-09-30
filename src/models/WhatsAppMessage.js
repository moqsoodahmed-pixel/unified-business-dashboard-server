import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppConversation', required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    phone: { type: String, required: true },
    account: String, // key of the WhatsApp (MSG91) number that sent / received this message
    direction: { type: String, enum: ['in', 'out'], required: true },
    type: { type: String, enum: ['text', 'image', 'video', 'audio', 'document', 'template', 'interactive', 'location', 'button', 'reaction', 'contacts', 'other'], default: 'text' },
    text: { type: String, default: '' },
    media: { url: String, mimeType: String, filename: String, caption: String },
    template: { name: String, language: String, variables: [String] },
    providerMessageId: { type: String }, // MSG91 `uuid` (Meta wamid)
    providerRequestId: { type: String }, // MSG91 request id returned on send
    status: { type: String, enum: ['queued', 'sent', 'delivered', 'read', 'failed', 'received'], default: 'queued' },
    statusHistory: [{ status: String, at: Date, _id: false }],
    error: { code: String, message: String },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentAt: Date,
    deliveredAt: Date,
    readAt: Date,
    failedAt: Date,
    providerTimestamp: Date,
  },
  { timestamps: true }
);
schema.index({ conversationId: 1, createdAt: 1 });
schema.index({ providerMessageId: 1 }, { unique: true, partialFilterExpression: { providerMessageId: { $type: 'string' } } });
schema.index({ providerRequestId: 1 });
schema.index({ phone: 1, direction: 1, createdAt: -1 });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ status: 1, createdAt: -1 });
schema.index({ createdAt: -1 });

export const WhatsAppMessage = mongoose.model('WhatsAppMessage', schema);
