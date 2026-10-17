type Cell = string | number | boolean | Date | null | undefined;

function escape(value: Cell): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  // Neutralize spreadsheet formula injection (usernames and answers are user-controlled).
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return [headers, ...rows].map(r => r.map(escape).join(',')).join('\n') + '\n';
}
