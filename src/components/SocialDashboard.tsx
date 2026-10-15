import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  Cell,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  FastForward,
  KeyRound,
  Moon,
  RefreshCw,
  Sun,
  X,
} from "lucide-react";
import type { DailyPayload, PlatformDailyMetric } from "../types";
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
  cn,
  formatCompact,
  formatCountdown,
  formatFull,
  formatPercent,
  startOfUtcDay,
  utcDateKey,
} from "../lib/utils";

const CACHE_KEY = "social-dashboard:payload:v3";
const OFFSET_KEY = "social-dashboard:day-offset:v1";
const TREND_DAYS = 14;

const isLiveSource = (source: string | undefined): boolean =>
  source !== undefined && source !== "mock";

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
  if (!isLiveSource(m.source)) return true;
  const profile = PLATFORM_APIS[m.name];
  return profile ? profile[key] !== null : true;
}

/** Live row whose numbers are running totals rather than one day's activity. */
const isLifetime = (m: PlatformDailyMetric): boolean =>
  isLiveSource(m.source) && PLATFORM_APIS[m.name]?.window === "lifetime";

/** View-weighted average across platforms whose API reports `key`. */
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
  const likes = weightedAverage(metrics, "likes").value;
  const share = weightedAverage(metrics, "share").value;
  return likes + share;
}

const formatLocalTime = (d: Date): string =>
  d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

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

function Badge({ metric, theme, size = "sm" }: { metric: PlatformDailyMetric; theme: Theme; size?: "sm" | "md" }) {
  const meta = PLATFORM_META[metric.name];
  const bg = platformColor(metric.name, theme);
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md font-mono font-bold",
        size === "sm" ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs",
      )}
      style={{ backgroundColor: bg, color: metric.name === "Threads" && theme === "dark" ? "#0B0B0B" : meta.onColor }}
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
  views: number;
  engagement: number;
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: TrendDatum }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs shadow-lg">
      <div className="font-mono font-semibold">{d.day}</div>
      <div className="mt-0.5 text-muted">{formatFull(d.views)} views</div>
      <div className="text-muted">{formatPercent(d.engagement)} engagement (likes + shares per view)</div>
    </div>
  );
}

/** Modal with the status and step-by-step fix for one platform's API key. */
function FixDialog({ status, theme, metric, onClose }: { status: ConnectionStatus; theme: Theme; metric: PlatformDailyMetric; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
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
            <Badge metric={metric} theme={theme} size="md" />
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
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:bg-panel-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
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
            walkthroughs are in DEPLOY.md.
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

  const [payload, setPayload] = useState<DailyPayload>(
    () => readCache() ?? buildDailyPayload(new Date(Date.now() + readOffset() * DAY_MS)),
  );
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [fixFor, setFixFor] = useState<string | null>(null);

  const liveCount = payload.metrics.filter((m) => isLiveSource(m.source)).length;
  const nextUpdate = startOfUtcDay(new Date(now.getTime() + DAY_MS));
  const nextUpdateMs = nextUpdate.getTime() - now.getTime();

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
    const base = buildDailyPayload(now);
    const live = await fetchLivePayload(now);
    if (!live) {
      setPayload({ ...base, apiReachable: false });
      setStatus(`Synced ${base.date}. The /api endpoints are unavailable here, so every platform shows demo data.`);
    } else {
      const merged = mergeLivePayload(base, live);
      setPayload(merged);
      const problems = Object.keys(live.errors).length;
      setStatus(
        `Synced ${merged.date}: ${live.metrics.length} live, ${11 - live.metrics.length} demo` +
          (problems > 0 ? `, ${problems} API ${problems === 1 ? "error" : "errors"} (see API connections).` : "."),
      );
    }
    setSyncing(false);
  }, [syncing, now]);

  // Sync once on load, and again whenever the UTC day rolls over.
  // The ref keeps StrictMode's double effect from firing two paid X reads.
  const todayKey = utcDateKey(now);
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

  const sorted = useMemo(() => [...payload.metrics].sort((a, b) => b.views - a.views), [payload.metrics]);

  const chartData: ChartDatum[] = useMemo(
    () =>
      sorted
        .filter((m) => m.views > 0)
        .map((m) => ({ id: m.id, label: PLATFORM_META[m.name].label, views: m.views, color: platformColor(m.name, theme) })),
    [sorted, theme],
  );
  const visibleData = useMemo(() => chartData.filter((d) => !hiddenIds.has(d.id)), [chartData, hiddenIds]);
  const totalAll = useMemo(() => chartData.reduce((s, d) => s + d.views, 0), [chartData]);
  const totalVisible = useMemo(() => visibleData.reduce((s, d) => s + d.views, 0), [visibleData]);
  const previousTotal = useMemo(
    () => payload.metrics.reduce((s, m) => s + (payload.previousViews[m.id] ?? 0), 0),
    [payload.metrics, payload.previousViews],
  );
  const totalDelta = previousTotal > 0 ? (totalAll - previousTotal) / previousTotal : 0;
  const lifetimeCount = payload.metrics.filter(isLifetime).length;

  const averages = useMemo(
    () => ({
      retention: weightedAverage(payload.metrics, "retention"),
      likes: weightedAverage(payload.metrics, "likes"),
      share: weightedAverage(payload.metrics, "share"),
    }),
    [payload.metrics],
  );

  const maxViews = sorted[0]?.views ?? 1;

  // There is no stored live history yet: earlier days use the demo generator for demo platforms
  // and hold live platforms at today's value, so the line doesn't jump where real data begins.
  const trend: TrendDatum[] = useMemo(() => {
    const today = startOfUtcDay(now).getTime();
    const liveById = new Map(payload.metrics.filter((m) => isLiveSource(m.source)).map((m) => [m.id, m]));
    const days: TrendDatum[] = [];
    for (let i = TREND_DAYS - 1; i >= 1; i--) {
      const p = buildDailyPayload(new Date(today - i * DAY_MS));
      const metrics = p.metrics.map((m) => liveById.get(m.id) ?? m);
      days.push({ day: p.date.slice(5), views: metrics.reduce((s, m) => s + m.views, 0), engagement: engagementRate(metrics) });
    }
    days.push({ day: payload.date.slice(5), views: totalAll, engagement: engagementRate(payload.metrics) });
    return days;
  }, [now, payload, totalAll]);

  const connections = useMemo(() => assessConnections(payload, now), [payload, now]);
  const attention = connections.filter((c) => c.needsAction);
  const connectionRank = (c: ConnectionStatus): number => (c.needsAction ? 0 : c.state === "demo" || c.state === "offline" ? 2 : 1);
  const orderedConnections = useMemo(
    () => [...connections].sort((a, b) => connectionRank(a) - connectionRank(b)),
    [connections],
  );
  const fixStatus = connections.find((c) => c.name === fixFor) ?? null;
  const fixMetric = payload.metrics.find((m) => m.name === fixFor);

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
            <p className="text-xs text-muted">Daily performance across 11 connected platforms</p>
          </div>
          <span
            className={cn(
              "ml-2 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
              liveCount === 0 ? "border-warn/40 bg-warn/10 text-warn" : "border-good/40 bg-good/10 text-good",
            )}
            title={liveCount === 0 ? "Every platform is showing generated demo numbers" : `${liveCount} platforms live; the rest show demo numbers`}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", liveCount === 0 ? "bg-warn" : "bg-good")} aria-hidden="true" />
            {liveCount === 0 ? "Demo data" : `Live · ${liveCount}/11`}
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
            Updated {formatLocalTime(new Date(payload.syncedAt))}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-muted">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            Next refresh {nextUpdate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · in
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

      {/* KPI row */}
      <section aria-label="Totals" className="grid shrink-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Total views"
          value={formatCompact(totalAll)}
          delta={totalDelta}
          hint={lifetimeCount > 0 ? `vs yesterday · ${lifetimeCount} platforms report lifetime totals` : "vs yesterday"}
        />
        <StatTile
          label="Avg. retention"
          value={averages.retention.count > 0 ? formatPercent(averages.retention.value) : "n/a"}
          hint={`Weighted by views · ${averages.retention.count} platforms report it`}
        />
        <StatTile
          label="Avg. likes / view"
          value={formatPercent(averages.likes.value)}
          hint={`Weighted by views · ${averages.likes.count} platforms`}
        />
        <StatTile
          label="Avg. share rate"
          value={formatPercent(averages.share.value)}
          hint={`Weighted by views · ${averages.share.count} platforms`}
        />
      </section>

      {/* Main grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-12">
        {/* Donut */}
        <section aria-labelledby="views-by-platform" className="panel flex min-h-0 flex-col p-4 lg:col-span-3">
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
          <div className="relative min-h-[220px] flex-1">
            {visibleData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={visibleData}
                    dataKey="views"
                    nameKey="label"
                    innerRadius="64%"
                    outerRadius="92%"
                    paddingAngle={1.5}
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
              <div className="flex h-full items-center justify-center text-center text-sm text-muted">All platforms hidden.</div>
            )}
            {visibleData.length > 0 && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="label">
                  {visibleData.length}/{chartData.length} platforms
                </span>
                <span className="text-3xl font-bold tabular-nums">{formatCompact(totalVisible)}</span>
              </div>
            )}
          </div>
          <ul className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-0.5" aria-label="Legend, toggle platforms in the chart">
            {chartData.map((d) => {
              const hidden = hiddenIds.has(d.id);
              return (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => toggle(d.id)}
                    aria-pressed={!hidden}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", hidden && "opacity-25")} style={{ backgroundColor: d.color }} aria-hidden="true" />
                    <span className={cn("flex-1 truncate", hidden && "text-muted line-through")}>{d.label}</span>
                    <span className="tabular-nums text-muted">{Math.round((d.views / totalAll) * 100)}%</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Trend + connections */}
        <div className="flex min-h-0 flex-col gap-3 lg:col-span-5">
          <section aria-labelledby="trend" className="panel flex min-h-[240px] flex-[3] flex-col p-4">
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
            {liveCount > 0 && <p className="text-[11px] text-muted">Live platforms have no stored history yet, so earlier days hold them at today's value.</p>}
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
                  <YAxis yAxisId="v" tick={{ fill: colors.axis, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatCompact(v)} width={44} />
                  <YAxis yAxisId="e" orientation="right" hide domain={["dataMin - 0.005", "dataMax + 0.005"]} />
                  <Tooltip content={<TrendTooltip />} cursor={{ stroke: colors.grid }} />
                  <Area yAxisId="v" type="monotone" dataKey="views" stroke={colors.accent} strokeWidth={2} fill="url(#viewsFill)" isAnimationActive={false} />
                  <Line yAxisId="e" type="monotone" dataKey="engagement" stroke={colors.accent2} strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section aria-labelledby="connections" className="panel flex min-h-0 flex-[2] flex-col p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id="connections" className="label">
                API connections
              </h2>
              {attention.length > 0 ? (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-bad">
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> {attention.length} need attention
                </span>
              ) : (
                <span className="text-xs text-muted">Click a platform for key details</span>
              )}
            </div>
            <ul className="mt-2 grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-x-3 gap-y-1 xl:grid-cols-3">
              {orderedConnections.map((c) => (
                <li key={c.name} className="min-h-0">
                  <button
                    type="button"
                    onClick={() => setFixFor(c.name)}
                    className={cn(
                      "flex h-full w-full items-center gap-2 rounded-lg border px-2 py-1 text-left hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      c.needsAction ? "border-bad/40 bg-bad/5" : "border-transparent",
                    )}
                    title={c.detail ?? c.summary}
                  >
                    <span className={cn("h-2 w-2 shrink-0 rounded-full", STATE_STYLE[c.state])} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{PLATFORM_META[c.name].label}</span>
                      <span className={cn("block truncate text-[11px]", c.needsAction ? "text-bad" : "text-muted")}>{c.summary}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>

        {/* Platform overview */}
        <section aria-labelledby="overview" className="panel flex min-h-0 flex-col p-4 lg:col-span-4">
          <h2 id="overview" className="label">
            Platform overview
          </h2>
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
            {sorted.map((m) => {
              const profile = isLiveSource(m.source) ? PLATFORM_APIS[m.name] : undefined;
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
                <li key={m.id} className="flex min-h-0 flex-1 flex-col justify-center border-b border-line/60 last:border-0">
                  <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_3.5rem_3.5rem] items-center gap-2 text-xs">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge metric={m} theme={theme} />
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

      {fixStatus && fixMetric && <FixDialog status={fixStatus} theme={theme} metric={fixMetric} onClose={() => setFixFor(null)} />}
    </div>
  );
}
