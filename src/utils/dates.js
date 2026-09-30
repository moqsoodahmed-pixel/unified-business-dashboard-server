import { env } from '../config/env.js';

const TZ_PARTS = (date, tz) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
};

/** Offset (ms) of `tz` from UTC at the instant `date`. */
function tzOffsetMs(date, tz) {
  const p = TZ_PARTS(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

export function startOfDay(date = new Date(), tz = env.TIMEZONE) {
  const p = TZ_PARTS(date, tz);
  const utcMidnight = Date.UTC(p.y, p.m - 1, p.d);
  return new Date(utcMidnight - tzOffsetMs(new Date(utcMidnight), tz));
}

export const addDays = (date, n) => new Date(date.getTime() + n * 86400000);

/** Resolve a named range or custom from/to into { from, to } (to is exclusive). */
export function resolveRange({ range = 'last7', from, to } = {}, now = new Date()) {
  const today = startOfDay(now);
  switch (range) {
    case 'today': return { from: today, to: addDays(today, 1), range };
    case 'yesterday': return { from: addDays(today, -1), to: today, range };
    case 'last30': return { from: addDays(today, -29), to: addDays(today, 1), range };
    case 'custom': {
      const f = from ? new Date(from) : addDays(today, -6);
      const t = to ? new Date(to) : now;
      if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return { from: addDays(today, -6), to: addDays(today, 1), range: 'last7' };
      return { from: startOfDay(f), to: addDays(startOfDay(t), 1), range };
    }
    case 'last7':
    default: return { from: addDays(today, -6), to: addDays(today, 1), range: 'last7' };
  }
}

/** Bucket key (YYYY-MM-DD in configured TZ) for a date. */
export function dayKey(date, tz = env.TIMEZONE) {
  const p = TZ_PARTS(new Date(date), tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function enumerateDays({ from, to }) {
  const keys = [];
  for (let d = from; d < to; d = addDays(d, 1)) keys.push(dayKey(new Date(d.getTime() + 3600000)));
  return [...new Set(keys)];
}

export function formatDateTime(date, tz = env.TIMEZONE) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(date)).replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
}
