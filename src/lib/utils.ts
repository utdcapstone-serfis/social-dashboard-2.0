import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const full = new Intl.NumberFormat("en-US");

export const formatCompact = (n: number): string => compact.format(n);
export const formatFull = (n: number): string => full.format(n);
export const formatPercent = (ratio: number, digits = 1): string =>
  `${(ratio * 100).toFixed(digits)}%`;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD in UTC. */
export function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Midnight UTC at the start of the day containing `d`. */
export function startOfUtcDay(d: Date): Date {
  return new Date(`${utcDateKey(d)}T00:00:00.000Z`);
}

export function formatCountdown(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/* ------------------------------------------------------------------ */
/* Dallas / US Central time: the dashboard's day starts at local midnight */
/* ------------------------------------------------------------------ */

export const DASHBOARD_TZ = "America/Chicago";

const centralDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: DASHBOARD_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD of `d` on the Central-time calendar. */
export function centralDateKey(d: Date): string {
  return centralDate.format(d);
}

/**
 * The instant of the next Central-time midnight after `d`. Midnight is 05:00 or
 * 06:00 UTC depending on daylight saving, so try both and keep the one that is
 * really 00:00 in Chicago.
 */
export function nextCentralMidnight(d: Date): Date {
  const [y, m, day] = centralDateKey(d).split("-").map(Number);
  for (const utcHour of [5, 6]) {
    const candidate = new Date(Date.UTC(y, m - 1, day + 1, utcHour));
    const hm = new Intl.DateTimeFormat("en-US", { timeZone: DASHBOARD_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(candidate);
    if (hm === "00:00") return candidate;
  }
  return new Date(Date.UTC(y, m - 1, day + 1, 6));
}

/** "Oct 14, 10:12 PM CT" */
export function formatCentral(d: Date, withDate = true): string {
  const text = d.toLocaleString("en-US", {
    timeZone: DASHBOARD_TZ,
    ...(withDate ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
  });
  return `${text} CT`;
}
