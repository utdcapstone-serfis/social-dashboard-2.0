import type {
  DailyPayload,
  PlatformDailyMetric,
  PlatformMeta,
  PlatformName,
} from "../types";
import { DAY_MS, startOfUtcDay, utcDateKey } from "../lib/utils";

/** Brand colors + accessible foreground colors. */
export const PLATFORM_META: Record<PlatformName, PlatformMeta> = {
  Facebook: { color: "#1877F2", onColor: "#FFFFFF", badge: "f", label: "Facebook" },
  YouTube: { color: "#FF0000", onColor: "#FFFFFF", badge: "YT", label: "YouTube" },
  Instagram: { color: "#C13584", onColor: "#FFFFFF", badge: "IG", label: "Instagram" },
  TikTok: { color: "#25F4EE", onColor: "#0B0B0B", badge: "Tk", label: "TikTok" },
  LinkedIn: { color: "#004182", onColor: "#FFFFFF", badge: "in", label: "LinkedIn" },
  Pinterest: { color: "#BD081C", onColor: "#FFFFFF", badge: "P", label: "Pinterest" },
  Twitter: { color: "#1D9BF0", onColor: "#06121F", badge: "X", label: "Twitter / X" },
  Snapchat: { color: "#FFFC00", onColor: "#0B0B0B", badge: "Sc", label: "Snapchat" },
  Threads: { color: "#101010", onColor: "#FFFFFF", badge: "@", label: "Threads" },
  Reddit: { color: "#FF4500", onColor: "#0B0B0B", badge: "r/", label: "Reddit" },
  Bluesky: { color: "#6AA9FF", onColor: "#06121F", badge: "Bs", label: "Bluesky" },
};

/** Baseline daily numbers; each daily payload jitters around these. */
const BASE_METRICS: ReadonlyArray<Omit<PlatformDailyMetric, "lastUpdated">> = [
  { id: "facebook", name: "Facebook", views: 1_284_500, retentionRate: 0.31, likesPerView: 0.038, shareRate: 0.012 },
  { id: "youtube", name: "YouTube", views: 2_146_900, retentionRate: 0.46, likesPerView: 0.044, shareRate: 0.006 },
  { id: "instagram", name: "Instagram", views: 1_732_300, retentionRate: 0.39, likesPerView: 0.061, shareRate: 0.017 },
  { id: "tiktok", name: "TikTok", views: 2_874_200, retentionRate: 0.52, likesPerView: 0.079, shareRate: 0.024 },
  { id: "linkedin", name: "LinkedIn", views: 318_700, retentionRate: 0.27, likesPerView: 0.028, shareRate: 0.009 },
  { id: "pinterest", name: "Pinterest", views: 452_100, retentionRate: 0.22, likesPerView: 0.018, shareRate: 0.014 },
  { id: "twitter", name: "Twitter", views: 986_400, retentionRate: 0.18, likesPerView: 0.022, shareRate: 0.011 },
  { id: "snapchat", name: "Snapchat", views: 641_800, retentionRate: 0.44, likesPerView: 0.033, shareRate: 0.019 },
  { id: "threads", name: "Threads", views: 274_600, retentionRate: 0.24, likesPerView: 0.047, shareRate: 0.008 },
  { id: "reddit", name: "Reddit", views: 395_300, retentionRate: 0.29, likesPerView: 0.052, shareRate: 0.005 },
  { id: "bluesky", name: "Bluesky", views: 96_800, retentionRate: 0.21, likesPerView: 0.058, shareRate: 0.013 },
];

/** Deterministic PRNG so the same day always yields the same payload. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

function metricsForDay(dateKey: string): PlatformDailyMetric[] {
  const lastUpdated = `${dateKey}T00:00:00.000Z`;
  return BASE_METRICS.map((base) => {
    const rand = mulberry32(hashString(`${dateKey}:${base.id}`));
    const jitter = (spread: number): number => 1 + (rand() - 0.5) * 2 * spread;
    return {
      ...base,
      views: Math.round(base.views * jitter(0.12)),
      retentionRate: clamp(Number((base.retentionRate * jitter(0.06)).toFixed(4)), 0.01, 0.99),
      likesPerView: clamp(Number((base.likesPerView * jitter(0.08)).toFixed(4)), 0.001, 0.5),
      shareRate: clamp(Number((base.shareRate * jitter(0.1)).toFixed(4)), 0.0005, 0.3),
      lastUpdated,
    };
  });
}

/** Builds the full payload for a UTC calendar day (synchronous, deterministic). */
export function buildDailyPayload(day: Date): DailyPayload {
  const dateKey = utcDateKey(day);
  const previousKey = utcDateKey(new Date(startOfUtcDay(day).getTime() - DAY_MS));
  const previousViews: Record<string, number> = {};
  for (const m of metricsForDay(previousKey)) previousViews[m.id] = m.views;

  return {
    date: dateKey,
    syncedAt: `${dateKey}T00:00:00.000Z`,
    metrics: metricsForDay(dateKey),
    previousViews,
  };
}

/** Simulates the once-per-day API fetch (network latency included). */
export function fetchDailyPayload(day: Date, latencyMs = 900): Promise<DailyPayload> {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(buildDailyPayload(day)), latencyMs);
  });
}

export const PLATFORM_ORDER: PlatformName[] = BASE_METRICS.map((m) => m.name);
