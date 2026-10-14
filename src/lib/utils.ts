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
