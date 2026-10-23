"use client";

import { Download, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import StatusDot from "@/components/StatusDot";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { API_URL, apiFetch, getToken } from "@/lib/api";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

// Admin Statistics (F26): headline numbers, applications over time, and
// breakdowns of who applied. Charts are plain CSS/SVG coloured with the theme
// tokens (brand for the main series, neutral tints for the rest), so they
// follow light, dark and the org's brand colour.

const LIVE_REFRESH_MS = 30 * 1000;
const LIVE_STORAGE_KEY = "hackdash_stats_live";

const STATUS_FILTERS = [
  ["all", "All submitted"],
  ["pending", "Pending"],
  ["accepted", "Accepted"],
  ["waitlisted", "Waitlisted"],
  ["rejected", "Rejected"],
  ["draft", "Drafts"],
];

// Stack order, bottom to top. Accepted carries the brand colour; the other
// statuses are neutral tints of the text colour, darkest to lightest. Every
// series is also named in the legend, tooltip and table view, so colour is
// never the only cue. `bar` fills SVG shapes, `dot` fills legend swatches.
const STATUS_SERIES = [
  {
    key: "pending",
    label: "Pending",
    bar: "fill-foreground/65",
    dot: "bg-foreground/65",
  },
  {
    key: "waitlisted",
    label: "Waitlisted",
    bar: "fill-foreground/35",
    dot: "bg-foreground/35",
  },
  { key: "accepted", label: "Accepted", bar: "fill-brand", dot: "bg-brand" },
  {
    key: "rejected",
    label: "Rejected",
    bar: "fill-foreground/15",
    dot: "bg-foreground/15",
  },
];
const DRAFT_SERIES = [
  {
    key: "draft",
    label: "Drafts",
    bar: "fill-foreground/35",
    dot: "bg-foreground/35",
  },
];

const number = (n) => Number(n || 0).toLocaleString();

function percent(count, total) {
  if (!total) return "0%";
  const value = (count * 100) / total;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}

function timeLabel(date) {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

// "2026-10-04" -> "Oct 4". The day is already in the event's time zone, so it
// is formatted as a plain calendar date (UTC) and never shifted by the viewer's.
function dayLabel(isoDay, withWeekday) {
  return new Date(`${isoDay}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(withWeekday ? { weekday: "short" } : {}),
  });
}

// A round step for the y axis so ticks land on whole numbers.
function niceStep(maxValue) {
  const target = Math.max(1, maxValue) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  for (const factor of [1, 2, 2.5, 5, 10]) {
    if (factor * magnitude >= target) return Math.max(1, factor * magnitude);
  }
  return Math.max(1, 10 * magnitude);
}

async function downloadFile(path, fallbackName) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // Not JSON; keep the generic message.
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const named = /filename="([^"]+)"/.exec(
    res.headers.get("Content-Disposition") || "",
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = named ? named[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

export default function StatsPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const [stats, setStats] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [round, setRound] = useState("");
  const [status, setStatus] = useState("");
  const [live, setLive] = useState(false);
  const latest = useRef(0);

  const query = new URLSearchParams();
  if (round) query.set("round", round);
  if (status) query.set("status", status);
  const queryString = query.toString();

  // Only the newest request may update the page, so a slow response for an
  // old filter can't overwrite a newer one.
  const load = useCallback(async () => {
    const mine = ++latest.current;
    setRefreshing(true);
    try {
      const data = await apiFetch(
        `/api/admin/stats${queryString ? `?${queryString}` : ""}`,
      );
      if (mine !== latest.current) return;
      setStats(data);
      setUpdatedAt(new Date());
      setError("");
    } catch (err) {
      if (mine !== latest.current) return;
      setError(err.message);
    } finally {
      if (mine === latest.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [queryString]);

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  // Event-day mode is remembered, so a lobby screen survives a page reload.
  useEffect(() => {
    try {
      setLive(window.localStorage.getItem(LIVE_STORAGE_KEY) === "1");
    } catch {
      // Storage can be blocked; live mode just won't be remembered.
    }
  }, []);

  useEffect(() => {
    if (!isAdmin || !live) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isAdmin, live, load]);

  if (!isAdmin) return null;

  function toggleLive(on) {
    setLive(on);
    try {
      window.localStorage.setItem(LIVE_STORAGE_KEY, on ? "1" : "0");
    } catch {
      // Not remembered; still works for this visit.
    }
  }

  const apps = stats?.applications;
  const rounds = (apps?.byRound || []).filter((r) => r._id);
  const submittedTotal = (apps?.byRound || []).reduce(
    (sum, r) => sum + r.total,
    0,
  );
  const acceptedTotal = (apps?.byRound || []).reduce(
    (sum, r) => sum + r.byStatus.accepted,
    0,
  );
  const eventDay = stats?.eventDay;

  // Headline numbers. Modules that aren't tracked (null) are left out.
  const kpis = stats
    ? [
        { label: "Applications", value: submittedTotal, note: "All rounds" },
        {
          label: "Accepted",
          value: acceptedTotal,
          note: `${percent(acceptedTotal, submittedTotal)} of submitted`,
        },
        {
          label: "Checked in",
          value: eventDay.checkedIn,
          note:
            `of ${number(eventDay.acceptedAttendees)} accepted` +
            (eventDay.forcedCheckIns
              ? `, ${number(eventDay.forcedCheckIns)} walk-in${eventDay.forcedCheckIns === 1 ? "" : "s"}`
              : ""),
        },
        {
          label: "Meals served",
          value: eventDay.mealsServed,
          note: `${number(eventDay.meals.length)} meal${eventDay.meals.length === 1 ? "" : "s"}`,
        },
        ...(eventDay.workshopAttendance == null
          ? []
          : [
              {
                label: "Workshop attendance",
                value: eventDay.workshopAttendance,
              },
            ]),
        ...(eventDay.hardwareOut == null
          ? []
          : [{ label: "Hardware out", value: eventDay.hardwareOut }]),
      ]
    : [];

  return (
    <div>
      <PageHeader
        title="Statistics"
        actions={
          <>
            <div className="flex items-center gap-2 pr-1">
              <Switch
                id="event-day-mode"
                size="sm"
                checked={live}
                onCheckedChange={toggleLive}
              />
              <Label
                htmlFor="event-day-mode"
                className="text-sm font-normal"
                title="Refresh every 30 seconds, for a lobby screen"
              >
                Event-day mode
              </Label>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={load}
            >
              <RefreshCw
                className={cn(refreshing && "animate-spin")}
                aria-hidden="true"
              />
              Refresh
            </Button>
          </>
        }
      />

      <div
        className="-mt-3 mb-6 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-live="polite"
      >
        {live
          ? <StatusDot tone="success" className="text-xs">
              Live, refreshes every {LIVE_REFRESH_MS / 1000} seconds
            </StatusDot>
          : null}
        {updatedAt
          ? <span className="tabular-nums">Updated {timeLabel(updatedAt)}</span>
          : null}
      </div>

      {error
        ? <Alert variant="destructive" className="mb-4">
            <AlertDescription>
              {stats
                ? `Couldn't refresh: ${error}. Showing the numbers from ${updatedAt ? timeLabel(updatedAt) : "earlier"}.`
                : error}
            </AlertDescription>
          </Alert>
        : null}

      {loading
        ? <StatsSkeleton />
        : !stats
          ? null
          : <div
              className={cn(
                "space-y-8 transition-opacity",
                refreshing && "opacity-60",
              )}
            >
              <div className="grid grid-cols-2 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 sm:grid-cols-4 [&>*]:border-r [&>*]:border-b [&>*]:border-border">
                {kpis.map((kpi) => (
                  <Kpi key={kpi.label} {...kpi} />
                ))}
              </div>

              <section className="space-y-3">
                <h2 className="text-base font-semibold">By round</h2>
                <RoundsTable rounds={apps.byRound} />
              </section>

              <section className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="mr-2 text-base font-semibold">Applicants</h2>
                  <Select
                    value={round || "all"}
                    onValueChange={(value) =>
                      setRound(value === "all" ? "" : value)
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Round"
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All rounds</SelectItem>
                      {rounds.map((r) => (
                        <SelectItem key={r._id} value={r._id}>
                          {r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={status || "all"}
                    onValueChange={(value) =>
                      setStatus(value === "all" ? "" : value)
                    }
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Status"
                      className="w-36"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_FILTERS.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {number(apps.total)} application
                    {apps.total === 1 ? "" : "s"} in this view
                  </span>
                </div>

                <Panel
                  title="Applications over time"
                  description={`By the day the application was started, in ${stats.timeZone || "the event's time zone"}.`}
                >
                  <TimeChart
                    days={apps.submissionsPerDay}
                    series={status === "draft" ? DRAFT_SERIES : STATUS_SERIES}
                  />
                </Panel>

                <div className="grid gap-4 md:grid-cols-2">
                  <Panel title="School">
                    <BarList chart={apps.bySchool} otherLabel="more schools" />
                  </Panel>
                  <Panel title="Education level">
                    <BarList chart={apps.byEducation} otherLabel="more" />
                  </Panel>
                  {apps.byGraduationYear
                    ? <Panel title="Graduation year">
                        <BarList
                          chart={apps.byGraduationYear}
                          otherLabel="more"
                        />
                      </Panel>
                    : null}
                  <Panel title="First-time hackers">
                    <BarList chart={experienceChart(apps.experience)} />
                    <p className="mt-3 text-xs text-muted-foreground">
                      {number(apps.experience.attendedThisEvent)} have attended
                      this event before.
                    </p>
                  </Panel>
                  <Panel title="Gender">
                    <BarList chart={apps.byGender} otherLabel="more" />
                  </Panel>
                  <Panel title="Major">
                    <BarList chart={apps.byMajor} otherLabel="more majors" />
                  </Panel>
                  <Panel title="T-shirt size">
                    <BarList chart={apps.byTshirtSize} otherLabel="more" />
                  </Panel>
                  {apps.questions.map((q) => (
                    <Panel key={q.key} title={q.label}>
                      <BarList chart={q} otherLabel="more" />
                      {q.type === "multiselect"
                        ? <p className="mt-3 text-xs text-muted-foreground">
                            People can pick several, so the choices add up to
                            more than the number of people.
                          </p>
                        : null}
                    </Panel>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                <h2 className="text-base font-semibold">Event day</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  <Panel title="Meals served">
                    <MealsList meals={eventDay.meals} />
                  </Panel>
                </div>
              </section>

              <ExportsSection round={round} status={status} />
            </div>}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="space-y-8" aria-busy="true">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

function Panel({ title, description, children }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description
          ? <CardDescription className="text-xs">{description}</CardDescription>
          : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// One headline number in the strip. Cells share the strip's border (the
// wrapper draws the outer ring; each cell draws its own right/bottom rule).
function Kpi({ label, value, note }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {number(value)}
      </div>
      {note
        ? <div className="text-xs text-muted-foreground">{note}</div>
        : null}
    </div>
  );
}

function experienceChart(experience) {
  const buckets = [
    { label: "First-time hackers", count: experience.firstTime },
    { label: "Returning hackers", count: experience.returning },
  ];
  const total = experience.firstTime + experience.returning;
  return {
    total,
    buckets: total ? buckets : [],
    other: { distinct: 0, count: 0 },
  };
}

// A ranked list of horizontal bars: label, bar, count and share. One colour,
// because the rows are one measure (people); the label carries the identity.
function BarList({ chart, otherLabel }) {
  if (!chart || !chart.total) {
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  const max = Math.max(1, ...chart.buckets.map((b) => b.count));
  return (
    <div className="space-y-2">
      {chart.buckets.map((bucket) => (
        <div
          key={bucket.label}
          className="grid grid-cols-[minmax(5rem,10rem)_1fr_5.5rem] items-center gap-3 text-sm"
          title={`${bucket.label}: ${number(bucket.count)} (${percent(bucket.count, chart.total)})`}
        >
          <span className="truncate">{bucket.label}</span>
          <span className="h-2 rounded-full bg-muted">
            <span
              className="block h-2 rounded-full bg-brand"
              style={{
                width: `${(bucket.count / max) * 100}%`,
                minWidth: bucket.count > 0 ? 3 : 0,
              }}
            />
          </span>
          <span className="text-right whitespace-nowrap tabular-nums">
            {number(bucket.count)}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {percent(bucket.count, chart.total)}
            </span>
          </span>
        </div>
      ))}
      {chart.other && chart.other.count > 0
        ? <p className="pt-1 text-xs text-muted-foreground tabular-nums">
            + {number(chart.other.distinct)} {otherLabel || "more"} (
            {number(chart.other.count)},{" "}
            {percent(chart.other.count, chart.total)})
          </p>
        : null}
    </div>
  );
}

function MealsList({ meals }) {
  if (!meals.length) {
    return (
      <p className="text-sm text-muted-foreground">No meals set up yet.</p>
    );
  }
  const total = meals.reduce((sum, m) => sum + m.served, 0);
  return (
    <BarList
      chart={{
        total,
        buckets: meals.map((m) => ({ label: m.name, count: m.served })),
        other: { distinct: 0, count: 0 },
      }}
    />
  );
}

function RoundsTable({ rounds }) {
  if (!rounds.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No application rounds yet.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 px-3 text-xs text-muted-foreground">
              Round
            </TableHead>
            <TableHead className="h-9 px-3 text-right text-xs text-muted-foreground">
              Submitted
            </TableHead>
            {STATUS_SERIES.map((s) => (
              <TableHead
                key={s.key}
                className="h-9 px-3 text-right text-xs text-muted-foreground"
              >
                {s.label}
              </TableHead>
            ))}
            <TableHead className="h-9 px-3 text-right text-xs text-muted-foreground">
              Drafts
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rounds.map((r) => (
            <TableRow key={r._id || "none"}>
              <TableCell className="px-3 py-1.5 font-medium">
                {r.name}
              </TableCell>
              <TableCell className="px-3 py-1.5 text-right tabular-nums">
                {number(r.total)}
              </TableCell>
              {STATUS_SERIES.map((s) => (
                <TableCell
                  key={s.key}
                  className="px-3 py-1.5 text-right text-muted-foreground tabular-nums"
                >
                  {number(r.byStatus[s.key])}
                </TableCell>
              ))}
              <TableCell className="px-3 py-1.5 text-right text-muted-foreground tabular-nums">
                {number(r.byStatus.draft)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// Width of an element in pixels, kept current. The chart is drawn at its real
// size, so axis labels stay a readable 12 px at any screen width.
function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry.contentRect.width)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// Stacked columns, one per day, split by status. Hover a day for the exact
// numbers; "View as table" has every value without hovering.
function TimeChart({ days, series }) {
  const [hover, setHover] = useState(null);
  const box = useRef(null);
  const W = useWidth(box);

  if (!days.length) {
    return (
      <p className="text-sm text-muted-foreground">No applications yet.</p>
    );
  }

  const H = 240;
  const margin = { top: 12, right: 8, bottom: 28, left: 36 };
  const innerW = Math.max(1, W - margin.left - margin.right);
  const innerH = H - margin.top - margin.bottom;
  const band = innerW / days.length;
  const barW = Math.max(2, Math.min(28, band - 4));

  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const step = niceStep(maxTotal);
  const yMax = step * Math.ceil(maxTotal / step);
  const ticks = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);
  const y = (v) => margin.top + innerH - (v / yMax) * innerH;

  // One day label per ~64 px, and the last day too unless it would crowd the
  // label before it.
  const fit = Math.max(1, Math.floor(innerW / 64));
  const labelEvery = Math.max(1, Math.ceil(days.length / fit));
  const labelled = new Set();
  for (let i = 0; i < days.length; i += labelEvery) labelled.add(i);
  if (days.length - 1 - Math.max(...labelled) >= Math.ceil(labelEvery * 0.6)) {
    labelled.add(days.length - 1);
  }

  const seriesTotals = series.map((s) => ({
    ...s,
    total: days.reduce((sum, d) => sum + (d.byStatus[s.key] || 0), 0),
  }));
  const hovered = hover === null ? null : days[hover];
  const hoverLeft = hover === null ? 0 : margin.left + band * hover + band / 2;

  return (
    <div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {seriesTotals.map((s) => (
          <li key={s.key} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn("size-2.5 rounded-[3px]", s.dot)}
            />
            {s.label}
            <span className="text-muted-foreground tabular-nums">
              {number(s.total)}
            </span>
          </li>
        ))}
      </ul>

      <div ref={box} className="relative w-full">
        {W > 0
          ? <svg
              width={W}
              height={H}
              role="img"
              aria-label={`Applications per day, ${dayLabel(days[0].date)} to ${dayLabel(days[days.length - 1].date)}, split by status. A table with the same numbers follows.`}
            >
              <g className="stroke-border">
                {ticks.map((v) => (
                  <line
                    key={v}
                    x1={margin.left}
                    x2={W - margin.right}
                    y1={y(v)}
                    y2={y(v)}
                  />
                ))}
              </g>
              <g className="fill-muted-foreground text-xs">
                {ticks.map((v) => (
                  <text
                    key={v}
                    x={margin.left - 8}
                    y={y(v) + 4}
                    textAnchor="end"
                  >
                    {number(v)}
                  </text>
                ))}
                {days.map((d, i) =>
                  labelled.has(i)
                    ? <text
                        key={d.date}
                        x={margin.left + band * i + band / 2}
                        y={H - 8}
                        textAnchor="middle"
                      >
                        {dayLabel(d.date)}
                      </text>
                    : null,
                )}
              </g>

              {days.map((d, i) => {
                const x = margin.left + band * i + (band - barW) / 2;
                // A 2px gap separates stacked segments.
                const parts = series
                  .map((s) => ({ ...s, value: d.byStatus[s.key] || 0 }))
                  .filter((p) => p.value > 0);
                let running = 0;
                return (
                  <g key={d.date}>
                    {hover === i
                      ? <rect
                          x={margin.left + band * i}
                          y={margin.top}
                          width={band}
                          height={innerH}
                          className="fill-muted"
                          opacity="0.6"
                        />
                      : null}
                    {parts.map((p, index) => {
                      const bottom = y(running);
                      running += p.value;
                      const top = y(running);
                      const gap = index < parts.length - 1 ? 2 : 0;
                      return (
                        <rect
                          key={p.key}
                          x={x}
                          y={top}
                          width={barW}
                          height={Math.max(1, bottom - top - gap)}
                          rx={2}
                          className={p.bar}
                        />
                      );
                    })}
                  </g>
                );
              })}

              {days.map((d, i) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: hover layer for a chart whose every value is also in the table below
                <rect
                  key={d.date}
                  x={margin.left + band * i}
                  y={margin.top}
                  width={band}
                  height={innerH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseMove={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </svg>
          : <div style={{ height: H }} />}

        {hovered
          ? <div
              className="pointer-events-none absolute top-0 min-w-36 -translate-x-1/2 rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-md"
              style={{
                left: Math.min(Math.max(hoverLeft, 80), Math.max(80, W - 80)),
              }}
            >
              <div className="text-muted-foreground">
                {dayLabel(hovered.date, true)}
              </div>
              <div className="mb-1 font-medium tabular-nums">
                {number(hovered.total)} total
              </div>
              {series.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={cn("size-2 rounded-[2px]", s.dot)}
                  />
                  <span className="font-medium tabular-nums">
                    {number(hovered.byStatus[s.key])}
                  </span>
                  <span className="text-muted-foreground">{s.label}</span>
                </div>
              ))}
            </div>
          : null}
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <div className="mt-2 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 px-3 text-xs text-muted-foreground">
                  Day
                </TableHead>
                <TableHead className="h-8 px-3 text-right text-xs text-muted-foreground">
                  Total
                </TableHead>
                {series.map((s) => (
                  <TableHead
                    key={s.key}
                    className="h-8 px-3 text-right text-xs text-muted-foreground"
                  >
                    {s.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.map((d) => (
                <TableRow key={d.date}>
                  <TableCell className="px-3 py-1">
                    {dayLabel(d.date, true)}
                  </TableCell>
                  <TableCell className="px-3 py-1 text-right tabular-nums">
                    {number(d.total)}
                  </TableCell>
                  {series.map((s) => (
                    <TableCell
                      key={s.key}
                      className="px-3 py-1 text-right text-muted-foreground tabular-nums"
                    >
                      {number(d.byStatus[s.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

// Downloads (B29). Personal data, so the section says so; the file comes from
// an authenticated request, since a plain link can't carry the login token.
function ExportsSection({ round, status }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [consentQuestions, setConsentQuestions] = useState([]);
  const [consentKey, setConsentKey] = useState("");

  // The checkbox questions on the application forms: the one applicants tick to
  // share their resume with sponsors decides who goes into the resume bundle.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/admin/rounds")
      .then((data) => {
        if (cancelled) return;
        const byKey = new Map();
        for (const r of data.rounds || []) {
          for (const field of Array.isArray(r.formConfig) ? r.formConfig : []) {
            if (field?.type === "checkbox" && field.key) {
              byKey.set(field.key, field.label || field.key);
            }
          }
        }
        setConsentQuestions([...byKey].map(([key, label]) => ({ key, label })));
      })
      .catch(() => {
        if (!cancelled) setConsentQuestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(name, path, fallbackName) {
    setBusy(name);
    setError("");
    try {
      await downloadFile(path, fallbackName);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const scope = new URLSearchParams();
  if (round) scope.set("round", round);
  if (status) scope.set("status", status);
  const scopeString = scope.toString() ? `?${scope.toString()}` : "";

  const resumeQuery = new URLSearchParams({ consentKey });
  if (round) resumeQuery.set("round", round);

  const buttons = [
    [
      "applications",
      "Applications (CSV)",
      `/api/admin/exports/applications.csv${scopeString}`,
      "applications.csv",
    ],
    [
      "checkins",
      "Check-ins (CSV)",
      "/api/admin/exports/checkins.csv",
      "check-ins.csv",
    ],
    [
      "meals",
      "Meals served (CSV)",
      "/api/admin/exports/meals.csv",
      "meals.csv",
    ],
  ];

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Exports</h2>
        <p className="text-sm text-muted-foreground">
          These files contain personal information. Share them only with people
          who need them. The applications file follows the round and status
          chosen above.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {buttons.map(([name, label, path, fallback]) => (
          <Button
            key={name}
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(busy)}
            onClick={() => run(name, path, fallback)}
          >
            <Download aria-hidden="true" />
            {busy === name ? "Preparing" : label}
          </Button>
        ))}
      </div>

      <div className="space-y-2 border-t pt-4">
        <h3 className="text-sm font-medium">Resumes for sponsors (ZIP)</h3>
        <p className="text-sm text-muted-foreground">
          Accepted applicants who ticked the question below, and nobody else.
          The file can be large; keep this tab open until it finishes.
        </p>
        {consentQuestions.length === 0
          ? <p className="text-sm text-muted-foreground">
              Add a checkbox question to the application form (for example
              &ldquo;Share my resume with sponsors&rdquo;) to use this.
            </p>
          : <div className="flex flex-wrap items-center gap-2">
              <Select
                value={consentKey || undefined}
                onValueChange={setConsentKey}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Question that says an applicant agreed to share their resume"
                  className="w-72 max-w-full"
                >
                  <SelectValue placeholder="Choose the consent question" />
                </SelectTrigger>
                <SelectContent>
                  {consentQuestions.map((q) => (
                    <SelectItem key={q.key} value={q.key}>
                      {q.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={Boolean(busy) || !consentKey}
                onClick={() =>
                  run(
                    "resumes",
                    `/api/admin/exports/resumes.zip?${resumeQuery.toString()}`,
                    "resumes.zip",
                  )
                }
              >
                <Download aria-hidden="true" />
                {busy === "resumes" ? "Preparing" : "Download ZIP"}
              </Button>
            </div>}
      </div>

      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
    </section>
  );
}
