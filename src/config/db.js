import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);
// NOTE: sanitizeFilter is intentionally NOT enabled: it rewrites the operators ($in, $gte, $ne…) the services build themselves.
// User input is kept out of filters by express-mongo-sanitize (strips $-keys) and by zod query schemas that only allow scalars.

export async function connectDb(uri = env.MONGODB_URI) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  logger.info('MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export const dbState = () =>
  ({ 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[mongoose.connection.readyState] || 'unknown');
