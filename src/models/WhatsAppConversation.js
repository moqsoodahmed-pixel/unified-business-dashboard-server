import mongoose from 'mongoose';

const noteSchema = new mongoose.Schema(
  { text: { type: String, required: true, maxlength: 4000 }, author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, authorName: String },
  { timestamps: { createdAt: true, updatedAt: false } }
);

const schema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true },
    account: String, // key of the WhatsApp (MSG91) number this customer last wrote to; replies go out from it
    contactId: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsAppContact' },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    status: { type: String, enum: ['open', 'pending', 'resolved', 'archived'], default: 'open' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    unreadCount: { type: Number, default: 0 },
    markedUnread: { type: Boolean, default: false },
    lastMessageAt: { type: Date, default: Date.now },
    lastMessagePreview: { type: String, default: '' },
    lastMessageDirection: { type: String, enum: ['in', 'out'] },
    lastInboundAt: Date, // WhatsApp 24h customer-service window is measured from this
    messageCount: { type: Number, default: 0 },
    tags: { type: [String], default: [] },
    notes: { type: [noteSchema], default: [] },
  },
  { timestamps: true }
);
schema.index({ status: 1, lastMessageAt: -1 });
schema.index({ assignedTo: 1, lastMessageAt: -1 });
schema.index({ unreadCount: 1 });
schema.index({ priority: 1, lastMessageAt: -1 });

export const WhatsAppConversation = mongoose.model('WhatsAppConversation', schema);
