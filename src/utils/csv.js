const needsQuote = /[",\n\r]/;
// Neutralise spreadsheet formula injection (=, +, -, @ at start of cell).
const guard = (s) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    s = guard(s);
    return needsQuote.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return [head, ...body].join('\n');
}
