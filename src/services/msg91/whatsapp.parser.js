import { normalizePhone } from '../../utils/phone.js';

const tryJson = (v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return v;
  try { return JSON.parse(s); } catch { return v; }
};
const str = (v) => (typeof v === 'string' ? v : v == null ? undefined : String(v));

/** Pull text / media out of the several shapes MSG91 webhooks can carry (stringified JSON, Meta-style objects, plain text). */
export function extractContent(p) {
  let node = tryJson(p.messages ?? p.content ?? p.text ?? p.message);
  if (Array.isArray(node)) node = node[0];
  node = tryJson(node);

  let type = (p.contentType || p.type || 'text').toString().toLowerCase();
  let text = '';
  const media = {};

  if (typeof node === 'string') {
    text = node;
  } else if (node && typeof node === 'object') {
    type = (node.type || type).toString().toLowerCase();
    const body = node.text?.body ?? (typeof node.text === 'string' ? node.text : undefined) ?? node.body ?? node.message;
    text = str(body) || '';
    const m = node[type] && typeof node[type] === 'object' ? node[type] : null;
    if (m) {
      media.url = str(m.link || m.url || m.id);
      media.mimeType = str(m.mime_type || m.mimeType);
      media.filename = str(m.filename);
      media.caption = str(m.caption);
      if (!text && media.caption) text = media.caption;
    }
    const btn = node.button?.text || node.interactive?.button_reply?.title || node.interactive?.list_reply?.title;
    if (btn) { text = text || btn; type = 'button'; }
  }
  if (!text && p.button) { const b = tryJson(p.button); text = str(b?.text || b?.payload) || ''; type = 'button'; }
  if (!media.url && p.url) media.url = str(p.url);

  const known = ['text', 'image', 'video', 'audio', 'document', 'template', 'interactive', 'location', 'button', 'reaction', 'contacts'];
  return { type: known.includes(type) ? type : type === 'sticker' ? 'image' : 'other', text: text.slice(0, 4096), media: media.url || media.caption ? media : undefined };
}

const STATUS_MAP = {
  sent: 'sent', submitted: 'sent', accepted: 'sent', delivered: 'delivered', read: 'read', seen: 'read',
  failed: 'failed', undelivered: 'failed', undeliverable: 'failed', rejected: 'failed', error: 'failed',
};

/**
 * Normalise one MSG91 webhook object into { kind: 'inbound' | 'status' | 'other', ... }.
 * MSG91 documents `direction` (0 = inbound, 1 = outbound), `customerNumber`, `uuid`, `requestId`, `status`, `reason`.
 */
export function normalizeMsg91(p) {
  const direction = String(p.direction ?? '').toLowerCase();
  const status = STATUS_MAP[String(p.status ?? '').toLowerCase()];
  const phone = normalizePhone(p.customerNumber || p.from || p.mobile || p.recipient);
  const base = {
    phone,
    providerMessageId: str(p.uuid || p.messageId || p.message_id),
    requestId: str(p.requestId || p.request_id || p.crqid),
    profileName: str(p.profileName || p.senderName || p.customerName || p.name),
    reason: str(p.reason),
    ts: p.ts ? new Date(/^\d+$/.test(String(p.ts)) ? Number(p.ts) * (String(p.ts).length <= 10 ? 1000 : 1) : p.ts) : undefined,
    templateName: str(p.templateName),
    raw: p,
  };
  const inbound = direction === '0' || direction === 'inbound' || direction === 'in';
  const outbound = direction === '1' || direction === 'outbound' || direction === 'out';

  if (inbound && !status) return { kind: 'inbound', ...base, ...extractContent(p) };
  if (status && !inbound) return { kind: 'status', status, ...base };
  if (!direction && !status && phone && (p.content || p.messages || p.text)) return { kind: 'inbound', ...base, ...extractContent(p) };
  if (outbound) return { kind: 'other', ...base };
  return { kind: 'other', ...base };
}

/** Deterministic event id, because MSG91 doesn't send one. */
export function msg91EventId(n, payloadHash) {
  if (n.kind === 'inbound') return `in:${n.providerMessageId || n.requestId || payloadHash}`;
  if (n.kind === 'status') return `st:${n.providerMessageId || n.requestId || n.phone}:${n.status}:${n.ts?.getTime?.() || payloadHash.slice(0, 12)}`;
  return `ot:${payloadHash}`;
}
