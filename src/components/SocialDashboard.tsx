import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Eye,
  FastForward,
  Heart,
  Radio,
  Repeat2,
  RefreshCw,
  Share2,
  Timer,
} from "lucide-react";
import type { DailyPayload, PlatformDailyMetric } from "../types";
import { PLATFORM_META, buildDailyPayload } from "../data/mockData";
import { fetchLivePayload, mergeLivePayload } from "../data/metaApi";

const LIVE_SOURCE_LABEL: Record<string, string> = {
  meta: "Live data from the Meta Graph API",
  youtube: "Live data from the YouTube Analytics API",
  tiktok: "Live data from the TikTok Display API (lifetime totals)",
  x: "Live data from the X API v2 user timeline (latest 100 posts)",
};

const isLiveSource = (source: string | undefined): boolean =>
  source !== undefined && source !== "mock";
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

const CACHE_KEY = "social-dashboard:payload:v2";
const OFFSET_KEY = "social-dashboard:day-offset:v1";

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

/* ------------------------------ sub-components ------------------------------ */

interface ChartDatum {
  id: string;
  name: string;
  label: string;
  views: number;
  color: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
  total: number;
}

function ChartTooltip({ active, payload, total }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-lg">
      <div className="flex items-center gap-2 font-semibold text-slate-900">
        <span className="h-3 w-3 rounded-sm border border-slate-300" style={{ backgroundColor: d.color }} />
        {d.label}
      </div>
      <div className="mt-1 text-slate-600">
        {formatFull(d.views)} views · {formatPercent(d.views / total)}
      </div>
    </div>
  );
}

interface MetricRowProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  ratio: number; // 0..1, bar fill relative to the best platform
  color: string;
}

function MetricRow({ icon, label, value, ratio, color }: MetricRowProps) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5 text-slate-600">
          {icon}
          {label}
        </span>
        <span className="font-semibold tabular-nums text-slate-900">{value}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, Math.round(ratio * 100))}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

interface PlatformCardProps {
  metric: PlatformDailyMetric;
  previousViews: number;
  maxima: { retention: number; likes: number; share: number };
  hidden: boolean;
  onToggle: () => void;
}

function PlatformCard({ metric, previousViews, maxima, hidden, onToggle }: PlatformCardProps) {
  const meta = PLATFORM_META[metric.name];
  const delta = previousViews > 0 ? (metric.views - previousViews) / previousViews : 0;
  const up = delta >= 0;

  return (
    <article
      className={cn(
        "relative flex flex-col gap-4 overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-opacity",
        hidden && "opacity-60",
      )}
      aria-label={`${meta.label} daily metrics`}
    >
      <span className="absolute inset-x-0 top-0 h-1.5" style={{ backgroundColor: meta.color }} aria-hidden="true" />

      <header className="flex items-center justify-between gap-3 pt-1">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold"
            style={{ backgroundColor: meta.color, color: meta.onColor }}
            aria-hidden="true"
          >
            {meta.badge}
          </span>
          <h3 className="truncate text-base font-semibold text-slate-900">{meta.label}</h3>
          {isLiveSource(metric.source) && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-200"
              title={LIVE_SOURCE_LABEL[metric.source ?? ""] ?? "Live data"}
            >
              <Radio className="h-3 w-3" aria-hidden="true" />
              Live
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={!hidden}
          className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600"
        >
          {hidden ? "Show in chart" : "In chart"}
        </button>
      </header>

      <div>
        <div className="flex items-center gap-1.5 text-sm text-slate-600">
          <Eye className="h-4 w-4" aria-hidden="true" />
          Total views
        </div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="text-3xl font-bold tabular-nums text-slate-900">{formatCompact(metric.views)}</span>
          <span
            className={cn(
              "inline-flex items-center text-sm font-medium tabular-nums",
              up ? "text-emerald-700" : "text-red-700",
            )}
          >
            {up ? (
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ArrowDownRight className="h-4 w-4" aria-hidden="true" />
            )}
            {formatPercent(Math.abs(delta))}
            <span className="sr-only"> {up ? "up" : "down"} versus yesterday</span>
          </span>
        </div>
        <div className="text-xs text-slate-500">{formatFull(metric.views)} views · vs yesterday</div>
      </div>

      <div className="space-y-3">
        <MetricRow
          icon={<Repeat2 className="h-4 w-4" aria-hidden="true" />}
          label="Retention rate"
          value={formatPercent(metric.retentionRate)}
          ratio={metric.retentionRate / maxima.retention}
          color={meta.color}
        />
        <MetricRow
          icon={<Heart className="h-4 w-4" aria-hidden="true" />}
          label="Likes per view"
          value={formatPercent(metric.likesPerView)}
          ratio={metric.likesPerView / maxima.likes}
          color={meta.color}
        />
        <MetricRow
          icon={<Share2 className="h-4 w-4" aria-hidden="true" />}
          label="Share rate"
          value={formatPercent(metric.shareRate)}
          ratio={metric.shareRate / maxima.share}
          color={meta.color}
        />
      </div>
    </article>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  hint: string;
}

function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-slate-600">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{value}</div>
      <div className="text-xs text-slate-500">{hint}</div>
    </div>
  );
}

/* --------------------------------- page --------------------------------- */

export default function SocialDashboard() {
  const [dayOffset, setDayOffset] = useState<number>(readOffset);
  const now = useSimulatedNow(dayOffset);
  const todayKey = utcDateKey(now);

  const [payload, setPayload] = useState<DailyPayload>(
    () => readCache() ?? buildDailyPayload(new Date(Date.now() + readOffset() * DAY_MS)),
  );
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set());

  const isCurrent = payload.date === todayKey;
  const hasLive = payload.metrics.some((m) => isLiveSource(m.source));
  const nextUpdateMs = startOfUtcDay(new Date(now.getTime() + DAY_MS)).getTime() - now.getTime();

  useEffect(() => {
    writeCache(payload);
  }, [payload]);

  // True once a sync for the current day came back with every live platform OK.
  // Until then "Check for update" re-fetches, so a newly configured platform
  // (e.g. YouTube) can go live without waiting for the next UTC day.
  const fullyLive = useRef(false);

  const sync = useCallback(async () => {
    if (syncing) return;
    if (isCurrent && hasLive && fullyLive.current) {
      setStatus(`Already up to date. Next daily update in ${formatCountdown(nextUpdateMs)}.`);
      return;
    }
    setSyncing(true);
    setStatus("Fetching today's payload…");
    const base = buildDailyPayload(now);
    const live = await fetchLivePayload(now);
    if (!live) {
      fullyLive.current = false;
      setPayload(base);
      setStatus(
        `Synced ${base.date}. The /api endpoints are unavailable here, so all 11 platforms show mock data.`,
      );
    } else {
      const merged = mergeLivePayload(base, live);
      fullyLive.current = Object.keys(live.errors).length === 0;
      setPayload(merged);
      const liveLabels = live.metrics.map((m) => PLATFORM_META[m.name].label);
      const errors = Object.entries(live.errors).map(([id, msg]) => `${id}: ${msg}`);
      setStatus(
        [
          `Synced ${merged.date}.`,
          liveLabels.length > 0
            ? `Live for ${live.liveDate}: ${liveLabels.join(", ")}.`
            : "No live data returned.",
          errors.length > 0 ? `Errors — ${errors.join("; ")}.` : "",
          `${11 - live.metrics.length} platforms use mock data.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    }
    setSyncing(false);
  }, [syncing, isCurrent, hasLive, nextUpdateMs, now]);

  // Pull live Meta data once on first load when the cached payload has none.
  const autoSynced = useRef(false);
  useEffect(() => {
    if (autoSynced.current || hasLive) return;
    autoSynced.current = true;
    void sync();
  }, [hasLive, sync]);

  const simulateNextDay = useCallback(() => {
    const next = dayOffset + 1;
    setDayOffset(next);
    writeOffset(next);
    setStatus("Clock advanced 24h. A new daily payload is available to sync.");
  }, [dayOffset]);

  const toggle = useCallback((id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sorted = useMemo(
    () => [...payload.metrics].sort((a, b) => b.views - a.views),
    [payload.metrics],
  );

  const chartData: ChartDatum[] = useMemo(
    () =>
      sorted.map((m) => ({
        id: m.id,
        name: m.name,
        label: PLATFORM_META[m.name].label,
        views: m.views,
        color: PLATFORM_META[m.name].color,
      })),
    [sorted],
  );
  const visibleData = useMemo(() => chartData.filter((d) => !hiddenIds.has(d.id)), [chartData, hiddenIds]);

  const totalAll = useMemo(() => chartData.reduce((s, d) => s + d.views, 0), [chartData]);
  const totalVisible = useMemo(() => visibleData.reduce((s, d) => s + d.views, 0), [visibleData]);
  const previousTotal = useMemo(
    () => Object.values(payload.previousViews).reduce((s, v) => s + v, 0),
    [payload.previousViews],
  );

  const weighted = useMemo(() => {
    const w = (pick: (m: PlatformDailyMetric) => number): number =>
      payload.metrics.reduce((s, m) => s + pick(m) * m.views, 0) / totalAll;
    return {
      retention: w((m) => m.retentionRate),
      likes: w((m) => m.likesPerView),
      share: w((m) => m.shareRate),
    };
  }, [payload.metrics, totalAll]);

  const maxima = useMemo(
    () => ({
      retention: Math.max(...payload.metrics.map((m) => m.retentionRate)),
      likes: Math.max(...payload.metrics.map((m) => m.likesPerView)),
      share: Math.max(...payload.metrics.map((m) => m.shareRate)),
    }),
    [payload.metrics],
  );

  const totalDelta = previousTotal > 0 ? (totalAll - previousTotal) / previousTotal : 0;

  const updatedLabel = isCurrent
    ? "Updated today at 00:00 UTC"
    : `Updated ${payload.date} at 00:00 UTC (out of date)`;

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8">
        {/* Header + sync controls */}
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Social Analytics
            </h1>
            <p className="mt-1 text-slate-600">
              Daily performance across 11 platforms. Platform APIs report on a 24-hour cycle.
            </p>
          </div>

          <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center">
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2 font-medium text-slate-900">
                {isCurrent ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-700" aria-hidden="true" />
                ) : (
                  <CalendarClock className="h-4 w-4 text-amber-700" aria-hidden="true" />
                )}
                <span>{updatedLabel}</span>
              </div>
              <div className="flex items-center gap-2 text-slate-600">
                <Timer className="h-4 w-4" aria-hidden="true" />
                <span>
                  Next daily update in: <strong className="tabular-nums text-slate-900">{formatCountdown(nextUpdateMs)}</strong>
                </span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={sync}
                disabled={syncing}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-70",
                  isCurrent
                    ? "border border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
                    : "bg-indigo-700 text-white hover:bg-indigo-800",
                )}
              >
                <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} aria-hidden="true" />
                {syncing ? "Syncing…" : isCurrent ? "Check for update" : "Sync today's data"}
              </button>
              <button
                type="button"
                onClick={simulateNextDay}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2"
                title="Demo only: advance the simulated clock by 24 hours"
              >
                <FastForward className="h-4 w-4" aria-hidden="true" />
                Simulate next day
              </button>
            </div>
          </div>
        </header>

        <p role="status" aria-live="polite" className="mt-3 min-h-5 text-sm text-slate-600">
          {status}
        </p>

        {/* KPI row */}
        <section aria-label="Totals" className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total views"
            value={formatCompact(totalAll)}
            hint={`${totalDelta >= 0 ? "+" : "−"}${formatPercent(Math.abs(totalDelta))} vs yesterday`}
          />
          <StatTile label="Avg. retention rate" value={formatPercent(weighted.retention)} hint="Weighted by views" />
          <StatTile label="Avg. likes per view" value={formatPercent(weighted.likes)} hint="Weighted by views" />
          <StatTile label="Avg. share rate" value={formatPercent(weighted.share)} hint="Weighted by views" />
        </section>

        {/* Donut + legend */}
        <section
          aria-labelledby="views-breakdown"
          className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="views-breakdown" className="text-lg font-semibold text-slate-900">
              Views breakdown
            </h2>
            <button
              type="button"
              onClick={() => setHiddenIds(new Set())}
              disabled={hiddenIds.size === 0}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 disabled:opacity-50"
            >
              Show all platforms
            </button>
          </div>

          <div className="mt-4 grid grid-cols-1 items-center gap-6 lg:grid-cols-2">
            <div className="relative mx-auto h-72 w-full max-w-md sm:h-96">
              {visibleData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={visibleData}
                      dataKey="views"
                      nameKey="label"
                      innerRadius="62%"
                      outerRadius="92%"
                      paddingAngle={2}
                      stroke="#FFFFFF"
                      strokeWidth={2}
                    >
                      {visibleData.map((d) => (
                        <Cell key={d.id} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip total={totalVisible} />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full items-center justify-center text-center text-slate-600">
                  All platforms are hidden.
                  <br />
                  Toggle one in the legend.
                </div>
              )}
              {visibleData.length > 0 && (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-sm text-slate-600">
                    {visibleData.length} of {chartData.length} platforms
                  </span>
                  <span className="text-3xl font-bold tabular-nums text-slate-900">
                    {formatCompact(totalVisible)}
                  </span>
                  <span className="text-sm text-slate-600">views</span>
                </div>
              )}
            </div>

            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Chart legend, toggle platforms">
              {chartData.map((d) => {
                const hidden = hiddenIds.has(d.id);
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => toggle(d.id)}
                      aria-pressed={!hidden}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600",
                        hidden && "bg-slate-50 text-slate-500",
                      )}
                    >
                      <span
                        className={cn("h-4 w-4 shrink-0 rounded-sm border border-slate-400", hidden && "opacity-30")}
                        style={{ backgroundColor: d.color }}
                        aria-hidden="true"
                      />
                      <span className={cn("flex-1 font-medium", hidden ? "text-slate-500 line-through" : "text-slate-900")}>
                        {d.label}
                      </span>
                      <span className="tabular-nums text-slate-600">
                        {formatCompact(d.views)} · {formatPercent(d.views / totalAll)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>

        {/* Platform cards */}
        <section aria-labelledby="platform-metrics" className="mt-6">
          <h2 id="platform-metrics" className="text-lg font-semibold text-slate-900">
            Engagement &amp; performance by platform
          </h2>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sorted.map((m) => (
              <PlatformCard
                key={m.id}
                metric={m}
                previousViews={payload.previousViews[m.id] ?? 0}
                maxima={maxima}
                hidden={hiddenIds.has(m.id)}
                onToggle={() => toggle(m.id)}
              />
            ))}
          </div>
        </section>

        <footer className="mt-8 text-center text-xs text-slate-500">
          {hasLive
            ? `${payload.metrics
                .filter((m) => isLiveSource(m.source))
                .map((m) => PLATFORM_META[m.name].label)
                .join(", ")} live from platform APIs (last complete UTC day: ${payload.liveDate ?? "n/a"}). Other platforms are mock data.`
            : "Mock data, cached locally."}{" "}
          Platform APIs refresh once every 24 hours (00:00 UTC).
        </footer>
      </div>
    </div>
  );
}
