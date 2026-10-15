/**
 * Wall-clock ↔ UTC conversion for an IANA timezone using only Intl, with
 * explicit daylight-saving handling:
 *  - nonexistent local times (spring-forward gap) are rejected;
 *  - ambiguous local times (fall-back overlap) require choosing the earlier
 *    or later instant.
 * Safe for client and server.
 */

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Local wall-clock parts of an instant in `tz`. */
export function zonedParts(instant: Date | number, tz: string) {
  const parts = formatter(tz).formatToParts(typeof instant === "number" ? new Date(instant) : instant);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** UTC offset of `tz` at `instant`, in minutes (e.g. -240 for EDT). */
export function offsetMinutes(instant: number, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = instant - (instant % 1000 + 1000) % 1000;
  return Math.round((asUtc - truncated) / 60000);
}

export type LocalToUtcResult =
  | { ok: true; instant: Date }
  | { ok: false; reason: "INVALID" }
  | { ok: false; reason: "NONEXISTENT" }
  | { ok: false; reason: "AMBIGUOUS"; options: { earlier: Date; later: Date } };

export type Disambiguation = "earlier" | "later";

/**
 * Converts a local date ("YYYY-MM-DD") and time ("HH:mm") in `tz` to a UTC
 * instant. Ambiguous times are only resolved when `disambiguation` is given.
 */
export function zonedLocalToUtc(date: string, time: string, tz: string, disambiguation?: Disambiguation): LocalToUtcResult {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) return { ok: false, reason: "INVALID" };
  const [y, mo, da] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const [h, mi] = [Number(t[1]), Number(t[2])];
  const wall = Date.UTC(y, mo - 1, da, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da) return { ok: false, reason: "INVALID" };

  // Candidate offsets around this wall time cover any single DST transition.
  const offsets = new Set([offsetMinutes(wall - 18 * 3600_000, tz), offsetMinutes(wall, tz), offsetMinutes(wall + 18 * 3600_000, tz)]);
  const valid = [...offsets]
    .map((o) => wall - o * 60_000)
    .filter((instant) => offsetMinutes(instant, tz) * 60_000 === wall - instant)
    .sort((a, b) => a - b);
  const unique = [...new Set(valid)];
  if (unique.length === 0) return { ok: false, reason: "NONEXISTENT" };
  if (unique.length === 1) return { ok: true, instant: new Date(unique[0]!) };
  const earlier = new Date(unique[0]!);
  const later = new Date(unique[unique.length - 1]!);
  if (disambiguation === "earlier") return { ok: true, instant: earlier };
  if (disambiguation === "later") return { ok: true, instant: later };
  return { ok: false, reason: "AMBIGUOUS", options: { earlier, later } };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD" for an instant in `tz`. */
export function localDateKey(instant: Date | number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Local "HH:mm" for an instant in `tz`. */
export function localTimeKey(instant: Date | number, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Adds whole days to a "YYYY-MM-DD" key (calendar arithmetic, no timezone). */
export function addDaysToKey(date: string, days: number): string {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError("Invalid date key");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  return zonedLocalToUtc(value, "12:00", "UTC").ok;
}

/**
 * First instant of a local calendar day. Midnight can be nonexistent in some
 * zones (DST at 00:00), in which case the day starts at the first valid minute.
 */
export function startOfLocalDay(date: string, tz: string): Date {
  for (let minutes = 0; minutes < 180; minutes += 15) {
    const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
    const r = zonedLocalToUtc(date, time, tz, "earlier");
    if (r.ok) return r.instant;
  }
  throw new RangeError(`Cannot resolve start of day ${date} in ${tz}`);
}

/** [start, end) UTC range covering local days `from`..`to` inclusive. Handles 23/25-hour days. */
export function localDaysRange(from: string, to: string, tz: string): { start: Date; end: Date } {
  return { start: startOfLocalDay(from, tz), end: startOfLocalDay(addDaysToKey(to, 1), tz) };
}

/** Today's local date key in `tz`. */
export function todayKey(tz: string, now: Date = new Date()): string {
  return localDateKey(now, tz);
}
