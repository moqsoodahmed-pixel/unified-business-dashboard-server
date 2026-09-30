import http from 'node:http';
import { env, assertProductionConfig } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDb, disconnectDb } from './config/db.js';
import { createApp } from './app.js';
import { initSocket, closeSocket } from './services/socket.js';
import { registerDefaultHandlers } from './services/handlers.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { User } from './models/index.js';

assertProductionConfig();
await connectDb();
registerDefaultHandlers();

if ((await User.countDocuments()) === 0) {
  logger.warn('No users exist yet. Run `npm run seed` to create the three dashboard accounts.');
}

const app = createApp();
const server = http.createServer(app);
initSocket(server);
server.listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server listening'));
startJobs();

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  stopJobs();
  closeSocket();
  server.close(async () => { await disconnectDb(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
