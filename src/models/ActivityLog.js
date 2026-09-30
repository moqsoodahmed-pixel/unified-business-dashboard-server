import mongoose from 'mongoose';

const schema = new mongoose.Schema(
  {
    eventType: { type: String, required: true },
    severity: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    actorType: { type: String, enum: ['user', 'system', 'webhook', 'customer'], default: 'system' },
    actor: { userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: String, role: String },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    source: { type: String, default: 'system' }, // whatsapp | email | payment | telegram | auth | webhook | customer | system
    description: { type: String, required: true },
    metadata: mongoose.Schema.Types.Mixed, // always passed through redactDeep()
    ipAddress: String,
  },
  { timestamps: true }
);
schema.index({ createdAt: -1 });
schema.index({ eventType: 1, createdAt: -1 });
schema.index({ customerId: 1, createdAt: -1 });
schema.index({ source: 1, createdAt: -1 });
schema.index({ severity: 1, createdAt: -1 });

export const ActivityLog = mongoose.model('ActivityLog', schema);
