import { registerHandler } from './event.bus.js';
import { logActivity } from './activity.service.js';
import { notifyEvent } from './telegram/telegram.service.js';
import { emitToPermission } from './socket.js';

async function activityHandler(event) {
  await logActivity(event);
}

async function socketHandler(event) {
  const { def } = event;
  const payload = {
    type: event.type, label: def.label, severity: def.severity, category: def.category,
    description: event.description || def.label, at: event.at,
  };
  if (def.activity) emitToPermission('activity:read', 'activity:new', payload);
  if (def.severity === 'warning' || def.severity === 'error') {
    // Security events are for the super admin only.
    emitToPermission(def.category === 'auth' ? 'users:read' : 'activity:read', 'notification:new', payload);
  }
  if (def.category === 'system' && def.severity === 'error') emitToPermission('health:read', 'system:alert', payload);
}

async function telegramHandler(event) {
  await notifyEvent(event);
}

let registered = false;
export function registerDefaultHandlers() {
  if (registered) return;
  registered = true;
  registerHandler(activityHandler);
  registerHandler(socketHandler);
  registerHandler(telegramHandler);
}
