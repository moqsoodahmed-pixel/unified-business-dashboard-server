const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authkey|authorization|signature|cookie|hash|credential|private/i;
const MAX_DEPTH = 6;
const MAX_STRING = 4000;

/** Deep-copy `value`, masking any sensitive-looking keys. Safe for logs and stored metadata. */
export function redactDeep(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return '[binary]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (typeof value.toObject === 'function') value = value.toObject();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactDeep(v, depth + 1, seen));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactDeep(v, depth + 1, seen);
  }
  return out;
}

/** Mask a secret-ish identifier for display: a Razorpay key id becomes rzp_live_****  */
export function maskIdentifier(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^([a-z]+_(?:live|test)_)/i);
  if (m) return `${m[1]}****`;
  return s.length <= 4 ? '****' : `${s.slice(0, 2)}****${s.slice(-2)}`;
}

/** Remove any occurrence of the given secret values from a string. */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 6) out = out.split(String(s)).join('[REDACTED]');
  }
  return out;
}
