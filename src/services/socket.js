import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { permissionsFor } from '../constants/permissions.js';

let io = null;

export function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: env.CLIENT_URL.split(',').map((s) => s.trim()), credentials: true } });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('unauthorized'));
      const payload = jwt.verify(token, env.JWT_SECRET);
      socket.data.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const { role } = socket.data.user;
    for (const p of permissionsFor(role)) socket.join(`perm:${p}`);
    logger.debug({ role }, 'socket connected');
  });
  return io;
}

/** Emit only to sockets whose role holds `permission`. No-op when sockets aren't running (tests, scripts). */
export function emitToPermission(permission, event, payload) {
  if (io) io.to(`perm:${permission}`).emit(event, payload);
}

export const emitToAll = (event, payload) => io && io.emit(event, payload);
export const closeSocket = () => io && io.close();
