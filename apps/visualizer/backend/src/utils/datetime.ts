/**
 * Timestamp formatting matching persisted `library.db` columns.
 *
 * Three distinct formats are already stored and are not interchangeable:
 *
 *   - UTC with `+00:00` and microseconds → perspectives, frame-substance tables
 *   - UTC truncated to whole seconds → `image_scores.scored_at`
 *   - Naive local wall-clock, no offset → similarity rejections/groups
 *
 * `Date.prototype.toISOString()` is wrong for all three (UTC `Z`, millisecond precision).
 * These columns are sorted as text and rendered in the UI.
 *
 * JavaScript clocks resolve to milliseconds; the microsecond field is zero-padded
 * to six digits so text ordering matches existing rows.
 */

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** `YYYY-MM-DDTHH:MM:SS.ffffff`, built from whichever clock parts are passed. */
function format(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
): string {
  return (
    `${pad(y, 4)}-${pad(mo, 2)}-${pad(d, 2)}` +
    `T${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(ms, 3)}000`
  );
}

/** UTC instant with explicit `+00:00` offset and microsecond padding. */
export function nowIsoUtc(date: Date = new Date()): string {
  return (
    format(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ) + '+00:00'
  );
}

/** UTC instant truncated to whole seconds, as `image_scores.scored_at` holds it. */
export function nowIsoUtcSeconds(date: Date = new Date()): string {
  return nowIsoUtc(date).replace(/\.\d+(?=\+)/, '');
}

const STORED_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Epoch milliseconds of a stored timestamp, or `NaN` when it is not one. An offset is
 * honoured; none means local wall-clock, the shape `nowIsoLocal` writes. Compare stored
 * timestamps through this: as text, a local one and a UTC one are off by the offset.
 */
export function storedInstantMs(text: string): number {
  const m = STORED_TIMESTAMP.exec(text.trim());
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((m[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const zone = m[8];
  if (zone === undefined) return new Date(y, mo - 1, d, h, mi, s, ms).getTime();
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (zone === 'Z') return utc;
  const sign = zone.startsWith('-') ? -1 : 1;
  const offsetMin = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6));
  return utc - sign * offsetMin * 60_000;
}

/** Local wall-clock with no offset. Rows in similarity tables use this shape. */
export function nowIsoLocal(date: Date = new Date()): string {
  return format(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}
