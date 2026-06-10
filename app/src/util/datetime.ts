// West Africa Time helpers. WAT is a fixed UTC+1 with no daylight saving, so we
// can convert with a constant offset — no timezone database required.

const WAT_OFFSET_MIN = 60; // UTC+1

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Parse a `datetime-local` value ("YYYY-MM-DDTHH:MM") that the admin entered as
 * WAT wall-clock time into the corresponding UTC Date. Returns null for empty
 * or malformed input.
 */
export function watInputToUtc(value: string | undefined | null): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const utcMs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) -
    WAT_OFFSET_MIN * 60_000;
  const dt = new Date(utcMs);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Format a UTC Date as "YYYY-MM-DD HH:MM WAT" for display. */
export function formatWat(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
  const w = new Date(date.getTime() + WAT_OFFSET_MIN * 60_000);
  return (
    `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())} ` +
    `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())} WAT`
  );
}

/** Render a UTC Date as a WAT "YYYY-MM-DDTHH:MM" string for prefilling inputs. */
export function toWatInput(d: Date | string | null | undefined): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '';
  const w = new Date(date.getTime() + WAT_OFFSET_MIN * 60_000);
  return (
    `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}T` +
    `${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}`
  );
}
