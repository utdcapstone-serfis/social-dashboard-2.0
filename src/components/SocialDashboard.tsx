import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FastForward,
  Heart,
  KeyRound,
  Moon,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import type { DailyPayload, PlatformDailyMetric, PlatformName, TopPost } from "../types";
import { PLATFORM_META, buildDailyPayload } from "../data/mockData";
import { fetchLivePayload, mergeLivePayload } from "../data/metaApi";
import {
  PLATFORM_APIS,
  assessConnections,
  type ConnectionState,
  type ConnectionStatus,
} from "../data/platformApis";
import { CHART_COLORS, platformColor, useTheme, type Theme } from "../lib/theme";
import {
  DAY_MS,
  centralDateKey,
  cn,
  formatCentral,
  formatCompact,
  formatCountdown,
  formatFull,
  formatPercent,
  nextCentralMidnight,
} from "../lib/utils";

const CACHE_KEY = "social-dashboard:payload:v3";
const OFFSET_KEY = "social-dashboard:day-offset:v1";
const HISTORY_KEY = "social-dashboard:live-history:v1";
const TREND_DAYS = 14;
const TOP_POSTS = 5;

const isLiveSource = (source: string | undefined): boolean =>
  source !== undefined && source !== "mock";

const isLive = (m: PlatformDailyMetric): boolean => isLiveSource(m.source);

/** Platform id ("tiktok") -> name ("TikTok"), for posts that only carry the id. */
const NAME_BY_ID: Record<string, PlatformName> = Object.fromEntries(
  (Object.keys(PLATFORM_META) as PlatformName[]).map((name) => [name === "Twitter" ? "twitter" : name.toLowerCase(), name]),
);

/* ----------------------------- persistence ----------------------------- */

function readCache(): DailyPayload | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DailyPayload;
    return Array.isArray(parsed.metrics) && parsed.metrics.length === 11 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(payload: DailyPayload): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* storage unavailable: the in-memory state still works */
  }
}

function readOffset(): number {
  try {
    const n = Number(window.localStorage.getItem(OFFSET_KEY));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeOffset(n: number): void {
  try {
    window.localStorage.setItem(OFFSET_KEY, String(n));
  } catch {
    /* ignore */
  }
}

/** One real data point per Central-time day, recorded from live syncs. */
type LiveHistory = Record<string, { views: number; engagement: number }>;

function readHistory(): LiveHistory {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(HISTORY_KEY) ?? "{}") as LiveHistory;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeHistory(history: LiveHistory): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    /* ignore */
  }
}

/* -------------------------------- hooks -------------------------------- */

/** Wall-clock "now" re-evaluated every 30s plus a simulated day offset. */
function useSimulatedNow(dayOffset: number): Date {
  const [tick, setTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return useMemo(() => new Date(tick + dayOffset * DAY_MS), [tick, dayOffset]);
}

/* ---------------------------- metric helpers ---------------------------- */

type RatioKey = "retention" | "likes" | "share";

const RATIO_FIELD: Record<RatioKey, keyof Pick<PlatformDailyMetric, "retentionRate" | "likesPerView" | "shareRate">> = {
  retention: "retentionRate",
  likes: "likesPerView",
  share: "shareRate",
};

/**
 * Whether a metric is a real number from the platform's API. Live rows only
 * count what the API reports (TikTok has no retention, Bluesky has no views);
 * demo rows report everything.
 */
function reports(m: PlatformDailyMetric, key: RatioKey | "views"): boolean {
  if (!isLive(m)) return true;
  const profile = PLATFORM_APIS[m.name];
  return profile ? profile[key] !== null : true;
}

/** Live row whose numbers are running totals rather than one day's activity. */
const isLifetime = (m: PlatformDailyMetric): boolean => isLive(m) && PLATFORM_APIS[m.name]?.window === "lifetime";

/** View-weighted average across platforms whose API reports `key` and that had views. */
function weightedAverage(metrics: PlatformDailyMetric[], key: RatioKey): { value: number; count: number } {
  const field = RATIO_FIELD[key];
  let sum = 0;
  let weight = 0;
  let count = 0;
  for (const m of metrics) {
    if (!reports(m, key) || !reports(m, "views") || m.views <= 0) continue;
    sum += m[field] * m.views;
    weight += m.views;
    count += 1;
  }
  return { value: weight > 0 ? sum / weight : 0, count };
}

/** Likes + shares per view, view-weighted: the trend chart's engagement line. */
function engagementRate(metrics: PlatformDailyMetric[]): number {
  return weightedAverage(metrics, "likes").value + weightedAverage(metrics, "share").value;
}

/** Posts with a view count rank by views; the rest (Facebook, Bluesky) follow, by likes. */
function rankPosts(posts: TopPost[]): TopPost[] {
  return [...posts]
    .sort((a, b) => {
      if ((a.views === null) !== (b.views === null)) return a.views === null ? 1 : -1;
      return (b.views ?? 0) - (a.views ?? 0) || b.likes - a.likes;
    })
    .slice(0, TOP_POSTS);
}

/* ------------------------------ sub-components ------------------------------ */

interface StatTileProps {
  label: string;
  value: string;
  hint: React.ReactNode;
  delta?: number;
}

function StatTile({ label, value, hint, delta }: StatTileProps) {
  return (
    <div className="panel px-4 py-3">
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums tracking-tight xl:text-3xl">{value}</span>
        {delta !== undefined && <Delta value={delta} />}
      </div>
      <div className="truncate text-xs text-muted">{hint}</div>
    </div>
  );
}

function Delta({ value, className }: { value: number; className?: string }) {
  const up = value >= 0;
  return (
    <span className={cn("inline-flex items-center text-xs font-medium tabular-nums", up ? "text-good" : "text-bad", className)}>
      {up ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />}
      {formatPercent(Math.abs(value))}
      <span className="sr-only"> {up ? "up" : "down"} versus yesterday</span>
    </span>
  );
}

function Badge({ name, theme, size = "sm" }: { name: PlatformName; theme: Theme; size?: "sm" | "md" }) {
  const meta = PLATFORM_META[name];
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-mono font-bold",
        size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs",
      )}
      style={{
        backgroundColor: platformColor(name, theme),
        color: name === "Threads" && theme === "dark" ? "#0B0B0B" : meta.onColor,
      }}
      aria-hidden="true"
    >
      {meta.badge}
    </span>
  );
}

const STATE_STYLE: Record<ConnectionState, string> = {
  live: "bg-good",
  expiring: "bg-warn",
  expired: "bg-bad",
  missing: "bg-bad",
  billing: "bg-bad",
  "rate-limited": "bg-warn",
  error: "bg-bad",
  offline: "bg-muted",
  demo: "bg-muted/50",
};

/** Short right-hand status for the compact connections list. */
function shortStatus(c: ConnectionStatus): string {
  if (c.state === "live") return c.daysLeft !== undefined ? `OK · ${c.daysLeft}d` : "OK";
  if (c.state === "expiring" && c.daysLeft !== undefined) return `Expires in ${c.daysLeft}d`;
  return c.summary;
}

interface ChartDatum {
  id: string;
  label: string;
  views: number;
  color: string;
}

function DonutTooltip({ active, payload, total }: { active?: boolean; payload?: Array<{ payload: ChartDatum }>; total: number }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs shadow-lg">
      <div className="flex items-center gap-2 font-semibold">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: d.color }} />
        {d.label}
      </div>
      <div className="mt-0.5 text-muted">
        {formatFull(d.views)} views · {formatPercent(d.views / total)}
      </div>
    </div>
  );
}

interface TrendDatum {
  day: string;
  views: number | null;
  engagement: number | null;
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendDatum }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  if (d.views === null) return null;
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs shadow-lg">
      <div className="font-mono font-semibold">{d.day}</div>
      <div className="mt-0.5 text-muted">{formatFull(d.views)} views</div>
      <div className="text-muted">{formatPercent(d.engagement ?? 0)} engagement (likes + shares per view)</div>
    </div>
  );
}

/** Position in the "needs attention" list, so the dialog can step through every key to fix. */
interface FixQueue {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

/** Modal with the status and step-by-step fix for one platform's API key. */
function FixDialog({ status, theme, queue, onClose }: { status: ConnectionStatus; theme: Theme; queue?: FixQueue; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (queue && e.key === "ArrowLeft") queue.onPrev();
      else if (queue && e.key === "ArrowRight") queue.onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, queue]);
  const profile = PLATFORM_APIS[status.name];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="fix-title"
        className="panel max-h-[90vh] w-full max-w-xl overflow-y-auto p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Badge name={status.name} theme={theme} size="md" />
            <div>
              <h2 id="fix-title" className="text-lg font-semibold">
                {PLATFORM_META[status.name].label} connection
              </h2>
              <div className="flex items-center gap-2 text-sm text-muted">
                <span className={cn("h-2 w-2 rounded-full", STATE_STYLE[status.state])} aria-hidden="true" />
                {status.summary}
                {profile && <span>· {profile.api}</span>}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {queue && (
              <>
                <button
                  type="button"
                  onClick={queue.onPrev}
                  className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label="Previous key that needs attention"
                  title="Previous (←)"
                >
                  <ChevronLeft className="h-5 w-5" />
                </button>
                <span className="font-mono text-xs tabular-nums text-muted" aria-live="polite">
                  {queue.index + 1} of {queue.total}
                </span>
                <button
                  type="button"
                  onClick={queue.onNext}
                  className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label="Next key that needs attention"
                  title="Next (→)"
                >
                  <ChevronRight className="h-5 w-5" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {status.detail && (
          <div className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 font-mono text-xs text-ink">{status.detail}</div>
        )}

        <dl className="mt-4 grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Key lifetime</dt>
          <dd>{status.keyLifetime}</dd>
          {status.envVars.length > 0 && (
            <>
              <dt className="text-muted">Env vars</dt>
              <dd className="font-mono text-xs leading-5">{status.envVars.join(", ")}</dd>
            </>
          )}
          {profile && (
            <>
              <dt className="text-muted">Reports</dt>
              <dd>{profile.windowLabel}</dd>
            </>
          )}
        </dl>

        <div className="label mt-5">How to fix</div>
        <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          {status.fix.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {status.envVars.length > 0 && (
          <p className="mt-4 text-xs text-muted">
            Keys live only on the server (.env.local locally, Vercel environment variables in production); the browser never sees them. Full
            walkthroughs are in DEPLOY.md, or run "Check API Keys.bat".
          </p>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- page --------------------------------- */

export default function SocialDashboard() {
  const [theme, toggleTheme] = useTheme();
  const colors = CHART_COLORS[theme];
  const [dayOffset, setDayOffset] = useState<number>(readOffset);
  const now = useSimulatedNow(dayOffset);

  // The dashboard's day runs midnight to midnight Dallas time (US Central).
  const todayKey = centralDateKey(now);
  const today = useMemo(() => new Date(`${todayKey}T00:00:00.000Z`), [todayKey]);
  const nextUpdate = nextCentralMidnight(now);
  const nextUpdateMs = nextUpdate.getTime() - now.getTime();

  const [payload, setPayload] = useState<DailyPayload>(() => readCache() ?? buildDailyPayload(today));
  const [history, setHistory] = useState<LiveHistory>(readHistory);
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [fixFor, setFixFor] = useState<string | null>(null);

  const liveMetrics = useMemo(() => payload.metrics.filter(isLive), [payload.metrics]);
  const liveCount = liveMetrics.length;

  useEffect(() => {
    writeCache(payload);
  }, [payload]);

  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(""), 8000);
    return () => window.clearTimeout(id);
  }, [status]);

  const sync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setStatus("Fetching today's data…");
    const base = buildDailyPayload(today);
    const live = await fetchLivePayload(today);
    if (!live) {
      setPayload({ ...base, apiReachable: false });
      setStatus("The /api endpoints are unavailable here, so no live data could be loaded.");
    } else {
      const merged = mergeLivePayload(base, live);
      setPayload(merged);
      const problems = Object.keys(live.errors).length;
      setStatus(
        `Synced ${merged.date}: ${live.metrics.length} platforms live` +
          (problems > 0 ? `, ${problems} API ${problems === 1 ? "error" : "errors"} (see API connections).` : "."),
      );
    }
    setSyncing(false);
  }, [syncing, today]);

  // Sync on load and again when the Central-time day rolls over at midnight.
  // The ref keeps StrictMode's double effect from firing two paid X reads.
  const syncedDay = useRef<string | null>(null);
  useEffect(() => {
    if (syncedDay.current === todayKey) return;
    syncedDay.current = todayKey;
    void sync();
  }, [todayKey, sync]);

  const simulateNextDay = useCallback(() => {
    const next = dayOffset + 1;
    setDayOffset(next);
    writeOffset(next);
    setStatus("Demo: clock advanced 24h.");
  }, [dayOffset]);

  const toggle = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ------------------------------ derived ------------------------------ */

  // KPIs, donut and trend use real (live) numbers only; demo platforms appear only, dimmed, in the table.
  const totalViews = useMemo(() => liveMetrics.reduce((s, m) => s + (reports(m, "views") ? m.views : 0), 0), [liveMetrics]);
  const previousTotal = useMemo(
    () => liveMetrics.reduce((s, m) => s + (reports(m, "views") ? (payload.previousViews[m.id] ?? 0) : 0), 0),
    [liveMetrics, payload.previousViews],
  );
  const totalDelta = previousTotal > 0 ? (totalViews - previousTotal) / previousTotal : undefined;
  const lifetimeCount = liveMetrics.filter(isLifetime).length;
  const averages = useMemo(
    () => ({
      retention: weightedAverage(liveMetrics, "retention"),
      likes: weightedAverage(liveMetrics, "likes"),
      share: weightedAverage(liveMetrics, "share"),
    }),
    [liveMetrics],
  );
  const avgValue = (a: { value: number; count: number }): string => (a.count > 0 ? formatPercent(a.value) : "—");

  const viewPlatforms = useMemo(
    () => liveMetrics.filter((m) => reports(m, "views")).sort((a, b) => b.views - a.views),
    [liveMetrics],
  );
  const chartData: ChartDatum[] = useMemo(
    () =>
      viewPlatforms
        .filter((m) => m.views > 0)
        .map((m) => ({ id: m.id, label: PLATFORM_META[m.name].label, views: m.views, color: platformColor(m.name, theme) })),
    [viewPlatforms, theme],
  );
  const visibleData = useMemo(() => chartData.filter((d) => !hiddenIds.has(d.id)), [chartData, hiddenIds]);
  const totalVisible = useMemo(() => visibleData.reduce((s, d) => s + d.views, 0), [visibleData]);

  // Record today's real totals so the trend builds up from actual syncs.
  useEffect(() => {
    if (liveCount === 0) return;
    setHistory((prev) => {
      const entry = { views: totalViews, engagement: engagementRate(liveMetrics) };
      const old = prev[payload.date];
      if (old && old.views === entry.views && old.engagement === entry.engagement) return prev;
      const next = { ...prev, [payload.date]: entry };
      writeHistory(next);
      return next;
    });
  }, [payload.date, liveCount, liveMetrics, totalViews]);

  const trend: TrendDatum[] = useMemo(() => {
    const days: TrendDatum[] = [];
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const key = new Date(today.getTime() - i * DAY_MS).toISOString().slice(0, 10);
      const h = history[key];
      days.push({ day: key.slice(5), views: h?.views ?? null, engagement: h?.engagement ?? null });
    }
    return days;
  }, [today, history]);
  const trendDays = trend.filter((d) => d.views !== null).length;

  const sortedTable = useMemo(
    () => [...payload.metrics].sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || b.views - a.views),
    [payload.metrics],
  );
  const maxViews = Math.max(1, ...payload.metrics.map((m) => m.views));

  const topPosts = useMemo(() => rankPosts(payload.posts ?? []), [payload.posts]);

  const connections = useMemo(() => assessConnections(payload, now), [payload, now]);
  const attention = useMemo(() => connections.filter((c) => c.needsAction), [connections]);
  const wired = useMemo(
    () => connections.filter((c) => c.state !== "demo").sort((a, b) => Number(b.needsAction) - Number(a.needsAction)),
    [connections],
  );
  const notWired = connections.filter((c) => c.state === "demo").map((c) => PLATFORM_META[c.name].label);
  const fixStatus = connections.find((c) => c.name === fixFor) ?? null;
  // Arrows cycle through every key that needs attention, wrapping at either end.
  const fixIndex = attention.findIndex((c) => c.name === fixFor);
  const fixQueue: FixQueue | undefined = useMemo(() => {
    if (fixIndex < 0 || attention.length < 2) return undefined;
    const go = (step: number) => setFixFor(attention[(fixIndex + step + attention.length) % attention.length].name);
    return { index: fixIndex, total: attention.length, onPrev: () => go(-1), onNext: () => go(1) };
  }, [fixIndex, attention]);

  /* ------------------------------- render ------------------------------- */

  return (
    <div className="flex min-h-screen flex-col gap-3 p-3 lg:h-screen lg:overflow-hidden">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-base font-bold text-white">
            S
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight">Social Command Center</h1>
            <p className="text-xs text-muted">Daily performance across 11 platforms · day resets at midnight Dallas time</p>
          </div>
          <span
            className={cn(
              "ml-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              liveCount === 0 ? "border-warn/40 bg-warn/10 text-warn" : "border-good/40 bg-good/10 text-good",
            )}
            title={`${liveCount} of 11 platforms are connected to a live API`}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", liveCount === 0 ? "bg-warn" : "bg-good")} aria-hidden="true" />
            {liveCount === 0 ? "No live data" : `Live · ${liveCount}/11`}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {attention.length > 0 && (
            <button
              type="button"
              onClick={() => setFixFor(attention[0].name)}
              className="inline-flex items-center gap-1.5 rounded-full border border-bad/40 bg-bad/10 px-3 py-1.5 font-medium text-bad hover:bg-bad/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-bad"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              {attention.length} API {attention.length === 1 ? "key needs" : "keys need"} attention
            </button>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-muted">
            <CheckCircle2 className="h-3.5 w-3.5 text-good" aria-hidden="true" />
            Updated {formatCentral(new Date(payload.syncedAt))}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Next refresh {formatCentral(nextUpdate, false)} · in
            <strong className="tabular-nums text-ink">{formatCountdown(nextUpdateMs)}</strong>
          </span>
          <button
            type="button"
            onClick={simulateNextDay}
            title="Demo only: advance the simulated clock by 24 hours"
            aria-label="Simulate next day"
            className="rounded-full border border-line p-1.5 text-muted hover:bg-panel-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <FastForward className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            title={theme === "dark" ? "Light mode" : "Dark mode"}
            className="rounded-full border border-line p-1.5 text-muted hover:bg-panel-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-wait disabled:opacity-70"
          >
            <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} aria-hidden="true" />
            {syncing ? "Syncing…" : "Reload"}
          </button>
        </div>
      </header>

      {/* KPI row: live platforms only */}
      <section aria-label="Totals from live platforms" className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Total views"
          value={liveCount > 0 ? formatCompact(totalViews) : "—"}
          delta={totalDelta}
          hint={
            liveCount === 0
              ? "No live platforms yet"
              : `${viewPlatforms.length} live platforms${lifetimeCount > 0 ? ` · ${lifetimeCount} report lifetime totals` : ""}`
          }
        />
        <StatTile label="Avg. retention" value={avgValue(averages.retention)} hint={`Weighted by views · ${averages.retention.count} platforms with data`} />
        <StatTile label="Avg. likes / view" value={avgValue(averages.likes)} hint={`Weighted by views · ${averages.likes.count} platforms with data`} />
        <StatTile label="Avg. share rate" value={avgValue(averages.share)} hint={`Weighted by views · ${averages.share.count} platforms with data`} />
      </section>

      {/* Main grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-12">
        {/* Left: donut + compact connections */}
        <div className="flex min-h-0 flex-col gap-3 lg:col-span-3">
          <section aria-labelledby="views-by-platform" className="panel flex min-h-[260px] flex-1 flex-col p-4">
            <div className="flex items-center justify-between">
              <h2 id="views-by-platform" className="label">
                Views by platform
              </h2>
              {hiddenIds.size > 0 && (
                <button type="button" onClick={() => setHiddenIds(new Set())} className="text-xs text-accent hover:underline">
                  Show all
                </button>
              )}
            </div>
            <div className="my-2 flex min-h-0 flex-1 items-center justify-center">
            <div className="relative aspect-square h-full max-h-[200px] max-w-full">
              {visibleData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={visibleData}
                      dataKey="views"
                      nameKey="label"
                      innerRadius="66%"
                      outerRadius="96%"
                      paddingAngle={visibleData.length > 1 ? 1.5 : 0}
                      stroke={colors.panel}
                      strokeWidth={3}
                      isAnimationActive={false}
                    >
                      {visibleData.map((d) => (
                        <Cell key={d.id} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<DonutTooltip total={totalVisible} />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                // Empty ring: real platforms are connected but have no views yet.
                <div className="absolute inset-[2%] rounded-full border-[14px] border-line/70" aria-hidden="true" />
              )}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span className="label">{chartData.length > 0 ? `${visibleData.length}/${chartData.length} live` : "Live views"}</span>
                <span className="text-2xl font-bold tabular-nums">{formatCompact(totalVisible)}</span>
              </div>
            </div>
            </div>
            {viewPlatforms.length === 0 ? (
              <p className="text-center text-xs text-muted">No platform with view counts is connected yet.</p>
            ) : (
              <ul className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-0.5" aria-label="Legend, toggle platforms in the chart">
                {viewPlatforms.map((m) => {
                  const hidden = hiddenIds.has(m.id);
                  const empty = m.views <= 0;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => toggle(m.id)}
                        disabled={empty}
                        aria-pressed={!hidden}
                        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:hover:bg-transparent"
                      >
                        <span
                          className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", (hidden || empty) && "opacity-25")}
                          style={{ backgroundColor: platformColor(m.name, theme) }}
                          aria-hidden="true"
                        />
                        <span className={cn("flex-1 truncate", hidden && "line-through", (hidden || empty) && "text-muted")}>
                          {PLATFORM_META[m.name].label}
                        </span>
                        <span className="tabular-nums text-muted">
                          {empty ? "0" : `${Math.round((m.views / Math.max(1, totalViews)) * 100)}%`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="connections" className="panel shrink-0 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 id="connections" className="label">
                API connections
              </h2>
              {attention.length > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-bad">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" /> {attention.length} need attention
                </span>
              )}
            </div>
            <ul className="mt-1.5 grid grid-cols-2 gap-x-2">
              {wired.map((c) => (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => setFixFor(c.name)}
                    title={`${c.detail ?? c.summary} · click for details`}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_STYLE[c.state])} aria-hidden="true" />
                    <span className="shrink-0 font-medium">{PLATFORM_META[c.name].label}</span>
                    <span className={cn("ml-auto truncate", c.needsAction ? "text-bad" : "text-muted")}>{shortStatus(c)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {notWired.length > 0 && (
              <p className="mt-1 truncate px-1 text-[10px] text-muted" title="These platforms have no API integration yet">
                No API yet: {notWired.join(", ")}
              </p>
            )}
          </section>
        </div>

        {/* Middle: trend + top posts */}
        <div className="flex min-h-0 flex-col gap-3 lg:col-span-5">
          <section aria-labelledby="trend" className="panel flex min-h-[220px] flex-1 flex-col p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id="trend" className="label">
                Engagement trend · {TREND_DAYS}d
              </h2>
              <div className="flex items-center gap-3 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-3 rounded-sm" style={{ backgroundColor: colors.accent }} aria-hidden="true" /> Views
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-0.5 w-3" style={{ backgroundColor: colors.accent2 }} aria-hidden="true" /> Engagement rate
                </span>
              </div>
            </div>
            <p className="text-[11px] text-muted">
              Live platforms only · one point per day from real syncs ({trendDays} of {TREND_DAYS} days recorded)
            </p>
            <div className="min-h-0 flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend} margin={{ top: 10, right: 4, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={colors.accent} stopOpacity={0.45} />
                      <stop offset="100%" stopColor={colors.accent} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={colors.grid} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: colors.axis, fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis
                    yAxisId="v"
                    tick={{ fill: colors.axis, fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => formatCompact(v)}
                    width={44}
                    allowDecimals={false}
                    domain={[0, (max: number) => Math.max(10, max)]}
                  />
                  <YAxis yAxisId="e" orientation="right" hide domain={[0, "auto"]} />
                  <Tooltip content={<TrendTooltip />} cursor={{ stroke: colors.grid }} />
                  <Area
                    yAxisId="v"
                    type="monotone"
                    dataKey="views"
                    stroke={colors.accent}
                    strokeWidth={2}
                    fill="url(#viewsFill)"
                    dot={trendDays < 3 ? { r: 3, fill: colors.accent } : false}
                    isAnimationActive={false}
                  />
                  <Line yAxisId="e" type="monotone" dataKey="engagement" stroke={colors.accent2} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section aria-labelledby="top-posts" className="panel flex min-h-[200px] flex-1 flex-col p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id="top-posts" className="label">
                Top posts
              </h2>
              <span className="text-[11px] text-muted">Real posts from connected accounts</span>
            </div>
            {topPosts.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-sm text-muted">
                <span>No posts on the connected accounts yet.</span>
                <span className="text-xs">Your best-performing posts show up here after the next sync once you publish.</span>
              </div>
            ) : (
              <ol className="mt-1 flex min-h-0 flex-1 flex-col">
                {topPosts.map((p, i) => {
                  const name = NAME_BY_ID[p.platform];
                  return (
                    <li key={`${p.platform}:${p.id}`} className="flex min-h-0 flex-1 items-center gap-3 border-b border-line/60 text-sm last:border-0">
                      <span className="w-3 font-mono text-xs text-muted">{i + 1}</span>
                      {name && <Badge name={name} theme={theme} />}
                      {p.url ? (
                        <a href={p.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium hover:text-accent hover:underline" title={p.title}>
                          {p.title}
                        </a>
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-medium" title={p.title}>
                          {p.title}
                        </span>
                      )}
                      <span className="w-16 text-right font-semibold tabular-nums" title={p.views === null ? "This platform has no view count" : `${formatFull(p.views)} views`}>
                        {p.views === null ? "—" : formatCompact(p.views)}
                      </span>
                      <span className="flex w-14 items-center justify-end gap-1 text-xs tabular-nums text-muted">
                        <Heart className="h-3 w-3" aria-hidden="true" />
                        {formatCompact(p.likes)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>

        {/* Right: platform overview, live first, demo rows dimmed */}
        <section aria-labelledby="overview" className="panel flex min-h-0 flex-col p-4 lg:col-span-4">
          <div className="flex items-center justify-between">
            <h2 id="overview" className="label">
              Platform overview
            </h2>
            <span className="text-[10px] text-muted">Dimmed rows are demo data</span>
          </div>
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_3.5rem_3.5rem] gap-2 border-b border-line pb-1.5 font-mono text-[10px] uppercase tracking-wider text-muted">
            <span>Platform</span>
            <span className="text-right">Views</span>
            <span className="text-right" title="Each platform's closest retention signal; hover a cell for its definition">
              Retain
            </span>
            <span className="text-right">Likes/v</span>
            <span className="text-right">Share</span>
          </div>
          <ul className="flex min-h-0 flex-1 flex-col">
            {sortedTable.map((m) => {
              const live = isLive(m);
              const profile = live ? PLATFORM_APIS[m.name] : undefined;
              const prev = payload.previousViews[m.id] ?? 0;
              const delta = prev > 0 ? (m.views - prev) / prev : 0;
              const cell = (key: RatioKey) => {
                const field = RATIO_FIELD[key];
                const shown = reports(m, key);
                return (
                  <span
                    className={cn("text-right tabular-nums", !shown && "text-muted/60")}
                    title={profile ? (profile[key] ?? `${profile.api} does not report this`) : "Demo data"}
                  >
                    {shown ? formatPercent(m[field]) : "n/a"}
                  </span>
                );
              };
              return (
                <li
                  key={m.id}
                  className={cn("flex min-h-0 flex-1 flex-col justify-center border-b border-line/60 last:border-0", !live && "opacity-45")}
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_3.5rem_3.5rem] items-center gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge name={m.name} theme={theme} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{PLATFORM_META[m.name].label}</span>
                        <span className="block truncate text-[10px] text-muted" title={profile?.api}>
                          {profile ? profile.windowLabel : "Demo data"}
                        </span>
                      </span>
                    </span>
                    <span className="text-right" title={profile?.views ?? (profile ? `${profile.api} does not report views` : "Demo data")}>
                      <span className="block font-semibold tabular-nums">{reports(m, "views") ? formatCompact(m.views) : "n/a"}</span>
                      {isLifetime(m) || !reports(m, "views") ? (
                        <span className="block text-[10px] text-muted">lifetime</span>
                      ) : (
                        <Delta value={delta} className="text-[10px]" />
                      )}
                    </span>
                    {cell("retention")}
                    {cell("likes")}
                    {cell("share")}
                  </div>
                  <div className="mt-1 h-0.5 rounded-full bg-line/60" aria-hidden="true">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(1, (m.views / maxViews) * 100)}%`, backgroundColor: platformColor(m.name, theme) }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      {/* Sync status toast */}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          "pointer-events-none fixed bottom-4 left-1/2 z-40 max-w-xl -translate-x-1/2 rounded-full border border-line bg-panel-2 px-4 py-2 text-xs shadow-lg transition-opacity",
          status ? "opacity-100" : "opacity-0",
        )}
      >
        {status}
      </div>

      {fixStatus && <FixDialog status={fixStatus} theme={theme} queue={fixQueue} onClose={() => setFixFor(null)} />}
    </div>
  );
}
