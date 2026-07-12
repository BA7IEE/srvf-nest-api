export type CsvScalar = string | number | boolean | Date | null | undefined;

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

/** RFC 4180 field escaping plus spreadsheet-formula neutralization. */
export function escapeCsvField(value: CsvScalar): string {
  if (value === null || value === undefined) return '';
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const safe = CSV_FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
