import mongoose from 'mongoose';
import { ROLE_LIST } from '../constants/permissions.js';

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLE_LIST, required: true, unique: true }, // exactly one user per role
    isActive: { type: Boolean, default: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date, default: null },
    lastLoginAt: Date,
    lastLoginIp: String,
    passwordChangedAt: Date,
  },
  { timestamps: true }
);

schema.methods.toSafe = function toSafe() {
  return {
    id: this._id.toString(),
    name: this.name,
    email: this.email,
    username: this.username,
    role: this.role,
    isActive: this.isActive,
    lockUntil: this.lockUntil,
    lastLoginAt: this.lastLoginAt,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', schema);
