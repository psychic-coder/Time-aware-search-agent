import { DateTime, IANAZone } from "luxon";

export function isValidTimeZone(tz: string | undefined | null): tz is string {
  return typeof tz === "string" && tz.length > 0 && tz.length < 64 && IANAZone.isValidZone(tz);
}

/** Normalize an incoming tz header; falls back to UTC. Accepts legacy aliases like Asia/Calcutta. */
export function normalizeTimeZone(tz: string | undefined | null): string {
  return isValidTimeZone(tz) ? tz : "UTC";
}

/** "Tue 10 Nov 2026, 22:22 (Asia/Kolkata, UTC+05:30)" */
export function describeNow(now: Date, tz: string): string {
  const d = DateTime.fromJSDate(now).setZone(tz);
  return `${d.toFormat("ccc d LLL yyyy, HH:mm")} (${tz}, UTC${d.toFormat("ZZ")})`;
}

/** Local rendering of a UTC ISO timestamp: "Mon 9 Nov 2026 11:05". */
export function formatLocal(isoUtc: string, tz: string): string {
  return DateTime.fromISO(isoUtc, { zone: "utc" }).setZone(tz).toFormat("ccc d LLL yyyy HH:mm");
}

export function localDateLabel(isoUtc: string, tz: string): string {
  return DateTime.fromISO(isoUtc, { zone: "utc" }).setZone(tz).toFormat("ccc d LLL yyyy");
}

/** YYYY-MM-DD in a zone. */
export function localIsoDate(isoUtc: string, tz: string): string {
  return DateTime.fromISO(isoUtc, { zone: "utc" }).setZone(tz).toISODate() ?? isoUtc.slice(0, 10);
}

export function msSince(t0: number): number {
  return Math.round(performance.now() - t0);
}
