export type PlatformName =
  | "Facebook"
  | "YouTube"
  | "Instagram"
  | "TikTok"
  | "LinkedIn"
  | "Pinterest"
  | "Twitter"
  | "Snapchat"
  | "Threads"
  | "Reddit"
  | "Bluesky";

export interface PlatformDailyMetric {
  id: string;
  name: PlatformName;
  views: number;
  retentionRate: number; // 0.42 = 42%
  likesPerView: number; // 0.05 = 5%
  shareRate: number; // 0.015 = 1.5%
  lastUpdated: string; // ISO date
  /**
   * "meta" when the row came from the Graph API via /api/meta, "youtube" when it
   * came from the YouTube Analytics API via /api/youtube, "tiktok" when it came
   * from the TikTok Display API via /api/tiktok, "x" when it came from the X API v2
   * user timeline via /api/x; otherwise mock.
   */
  source?: "meta" | "youtube" | "tiktok" | "x" | "mock";
}

/** Static presentation data for a platform. */
export interface PlatformMeta {
  /** Brand color used for chart slices and accents. */
  color: string;
  /** Text color with accessible contrast on top of `color`. */
  onColor: string;
  /** 1–2 character badge label. */
  badge: string;
  /** Display label (Twitter is shown as "Twitter / X"). */
  label: string;
}

/** One day's worth of analytics for every platform. */
export interface DailyPayload {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  /** ISO timestamp of the (simulated) sync that produced this payload. */
  syncedAt: string;
  metrics: PlatformDailyMetric[];
  /** Previous day's views by platform id, for day-over-day deltas. */
  previousViews: Record<string, number>;
  /** UTC day the live metrics describe (the last complete day), if any. */
  liveDate?: string;
}
