"use client";

import { Download, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, apiFetch, getToken } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Admin Statistics (F26): headline numbers, applications over time, and
// breakdowns of who applied. Self-contained on purpose: charts are plain
// CSS/SVG, styled with local --st-* tokens that fall back to the app's own
// theme variables, so nothing here depends on (or restyles) shared components.

const LIVE_REFRESH_MS = 30 * 1000;
const LIVE_STORAGE_KEY = "hackdash_stats_live";

const STATUS_FILTERS = [
  ["", "All submitted"],
  ["pending", "Pending"],
  ["accepted", "Accepted"],
  ["waitlisted", "Waitlisted"],
  ["rejected", "Rejected"],
  ["draft", "Drafts"],
];

// Stack order, bottom to top. The order is what keeps neighbouring colours
// distinguishable (checked for light and dark, including colour blindness);
// every series is also named in the legend, tooltip and table view.
const STATUS_SERIES = [
  { key: "pending", label: "Pending", color: "var(--st-pending)" },
  { key: "waitlisted", label: "Waitlisted", color: "var(--st-waitlisted)" },
  { key: "accepted", label: "Accepted", color: "var(--st-accepted)" },
  { key: "rejected", label: "Rejected", color: "var(--st-rejected)" },
];
const DRAFT_SERIES = [
  { key: "draft", label: "Drafts", color: "var(--st-muted)" },
];

const CSS = `
.stats-root {
  --st-ink: var(--foreground, #171821);
  --st-muted: var(--muted, #6b7280);
  --st-grid: var(--border, #e5e7eb);
  --st-surface: var(--surface, #ffffff);
  --st-bar: var(--brand, #4f46e5);
  --st-pending: #2a78d6;
  --st-waitlisted: #eda100;
  --st-accepted: #1baf7a;
  --st-rejected: #e34948;
}
@media (prefers-color-scheme: dark) {
  .stats-root {
    --st-pending: #3987e5;
    --st-waitlisted: #c98500;
    --st-accepted: #199e70;
    --st-rejected: #e66767;
  }
}
.stats-root .st-refreshing { opacity: 0.6; transition: opacity 0.15s; }
.stats-root .st-axis text { fill: var(--st-muted); font-size: 11px; }
.stats-root .st-grid line { stroke: var(--st-grid); stroke-width: 1; }
.stats-root .st-bar-row { display: grid; grid-template-columns: minmax(90px, 36%) 1fr 2.6rem 2.6rem; gap: 0.6rem; align-items: center; font-size: 0.85rem; }
.stats-root .st-bar-count, .stats-root .st-bar-share { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.stats-root .st-bar-track { height: 10px; }
.stats-root .st-bar-fill { height: 10px; background: var(--st-bar); border-radius: 0 4px 4px 0; }
.stats-root .st-live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--st-accepted); margin-right: 0.4rem; }
.stats-root table.st-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.stats-root table.st-table th, .stats-root table.st-table td { padding: 0.45rem 0.6rem; text-align: right; border-bottom: 1px solid var(--st-grid); }
.stats-root table.st-table th:first-child, .stats-root table.st-table td:first-child { text-align: left; }
.stats-root table.st-table th { font-weight: 600; }
`;

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

  return (
    <div className="stats-root">
      <style>{CSS}</style>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.25rem",
        }}
      >
        <div>
          <h1
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              marginBottom: "0.25rem",
            }}
          >
            Statistics
          </h1>
          <p className="muted">
            Who applied, who showed up, and what was served.
          </p>
        </div>
        <div
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              fontSize: "0.9rem",
            }}
          >
            <input
              type="checkbox"
              checked={live}
              onChange={(e) => toggleLive(e.target.checked)}
            />
            Event-day mode
          </label>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", gap: "0.4rem" }}
            disabled={refreshing}
            onClick={load}
          >
            <RefreshCw
              size={16}
              aria-hidden="true"
              style={
                refreshing
                  ? { animation: "spin 1s linear infinite" }
                  : undefined
              }
            />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <p
        className="muted"
        style={{ fontSize: "0.82rem", marginBottom: "1rem" }}
        aria-live="polite"
      >
        {live
          ? <>
              <span className="st-live-dot" aria-hidden="true" />
              Live: refreshes every {LIVE_REFRESH_MS / 1000} seconds
            </>
          : "Event-day mode refreshes this page every 30 seconds, for a lobby screen."}
        {updatedAt ? ` · Updated ${timeLabel(updatedAt)}` : ""}
      </p>

      {error
        ? <div
            className="alert-error"
            role="alert"
            style={{ marginBottom: "1rem" }}
          >
            {stats
              ? `Couldn't refresh: ${error}. Showing the numbers from ${updatedAt ? timeLabel(updatedAt) : "earlier"}.`
              : error}
          </div>
        : null}

      {loading
        ? <p className="muted">Loading…</p>
        : !stats
          ? null
          : <div className={refreshing ? "st-refreshing" : undefined}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                  gap: "0.85rem",
                  marginBottom: "1.5rem",
                }}
              >
                <Kpi
                  label="Applications"
                  value={submittedTotal}
                  note="submitted, all rounds"
                />
                <Kpi
                  label="Accepted"
                  value={acceptedTotal}
                  note={`${percent(acceptedTotal, submittedTotal)} of submitted`}
                />
                <Kpi
                  label="Checked in"
                  value={eventDay.checkedIn}
                  note={
                    `of ${number(eventDay.acceptedAttendees)} accepted` +
                    (eventDay.forcedCheckIns
                      ? ` · ${number(eventDay.forcedCheckIns)} walk-in${eventDay.forcedCheckIns === 1 ? "" : "s"}`
                      : "")
                  }
                />
                <Kpi
                  label="Meals served"
                  value={eventDay.mealsServed}
                  note={`across ${number(eventDay.meals.length)} meal${eventDay.meals.length === 1 ? "" : "s"}`}
                />
                <Kpi
                  label="Workshop attendance"
                  value={eventDay.workshopAttendance}
                  note="not tracked yet"
                />
                <Kpi
                  label="Hardware out"
                  value={eventDay.hardwareOut}
                  note="not tracked yet"
                />
              </div>

              <Section title="By round">
                <RoundsTable rounds={apps.byRound} />
              </Section>

              <div
                style={{
                  display: "flex",
                  gap: "0.75rem",
                  alignItems: "center",
                  flexWrap: "wrap",
                  margin: "1.5rem 0 1rem",
                }}
              >
                <h2 style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  Who applied
                </h2>
                <select
                  className="select"
                  aria-label="Round"
                  style={{ maxWidth: 200 }}
                  value={round}
                  onChange={(e) => setRound(e.target.value)}
                >
                  <option value="">All rounds</option>
                  {rounds.map((r) => (
                    <option key={r._id} value={r._id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <select
                  className="select"
                  aria-label="Status"
                  style={{ maxWidth: 180 }}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {STATUS_FILTERS.map(([value, label]) => (
                    <option key={value || "all"} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <span className="muted" style={{ fontSize: "0.85rem" }}>
                  {number(apps.total)} application
                  {apps.total === 1 ? "" : "s"} in this view
                </span>
              </div>

              <Section title="Applications over time">
                <TimeChart
                  days={apps.submissionsPerDay}
                  series={status === "draft" ? DRAFT_SERIES : STATUS_SERIES}
                  timeZone={stats.timeZone}
                />
              </Section>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
                  gap: "1rem",
                  marginTop: "1rem",
                }}
              >
                <Section title="School">
                  <BarList chart={apps.bySchool} otherLabel="more schools" />
                </Section>
                <Section title="Education level">
                  <BarList chart={apps.byEducation} otherLabel="more" />
                </Section>
                {apps.byGraduationYear
                  ? <Section title="Graduation year">
                      <BarList
                        chart={apps.byGraduationYear}
                        otherLabel="more"
                      />
                    </Section>
                  : null}
                <Section title="First-time hackers">
                  <BarList chart={experienceChart(apps.experience)} />
                  <p
                    className="muted"
                    style={{ fontSize: "0.8rem", marginTop: "0.6rem" }}
                  >
                    {number(apps.experience.attendedThisEvent)} have attended
                    this event before.
                  </p>
                </Section>
                <Section title="Gender">
                  <BarList chart={apps.byGender} otherLabel="more" />
                </Section>
                <Section title="Major">
                  <BarList chart={apps.byMajor} otherLabel="more majors" />
                </Section>
                <Section title="T-shirt size">
                  <BarList chart={apps.byTshirtSize} otherLabel="more" />
                </Section>
                {apps.questions.map((q) => (
                  <Section key={q.key} title={q.label}>
                    <BarList chart={q} otherLabel="more" />
                    {q.type === "multiselect"
                      ? <p
                          className="muted"
                          style={{ fontSize: "0.8rem", marginTop: "0.6rem" }}
                        >
                          People can pick several, so the choices add up to more
                          than the number of people.
                        </p>
                      : null}
                  </Section>
                ))}
              </div>

              <div style={{ marginTop: "1.5rem" }}>
                <Section title="Meals served">
                  <MealsList meals={eventDay.meals} />
                </Section>
              </div>

              <div style={{ marginTop: "1.5rem" }}>
                <ExportsCard round={round} status={status} />
              </div>
            </div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="card" style={{ padding: "1.25rem" }}>
      <h3
        style={{
          fontSize: "0.95rem",
          fontWeight: 600,
          marginBottom: "0.85rem",
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

// Headline number. Whole numbers stay whole (1,284); a null value means the
// module that feeds it doesn't exist yet and shows a dash.
function Kpi({ label, value, note }) {
  return (
    <div className="card" style={{ padding: "1rem 1.1rem" }}>
      <div className="muted" style={{ fontSize: "0.82rem" }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.9rem",
          fontWeight: 650,
          lineHeight: 1.2,
          margin: "0.2rem 0",
        }}
      >
        {value === null || value === undefined ? "—" : number(value)}
      </div>
      <div className="muted" style={{ fontSize: "0.78rem" }}>
        {note}
      </div>
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
    return <p className="muted">No data yet.</p>;
  }
  const max = Math.max(1, ...chart.buckets.map((b) => b.count));
  return (
    <div style={{ display: "grid", gap: "0.55rem" }}>
      {chart.buckets.map((bucket) => (
        <div
          key={bucket.label}
          className="st-bar-row"
          title={`${bucket.label}: ${number(bucket.count)} (${percent(bucket.count, chart.total)})`}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {bucket.label}
          </span>
          <span className="st-bar-track">
            <span
              className="st-bar-fill"
              style={{
                display: "block",
                width: `${(bucket.count / max) * 100}%`,
                minWidth: bucket.count > 0 ? 2 : 0,
              }}
            />
          </span>
          <span className="st-bar-count">{number(bucket.count)}</span>
          <span className="st-bar-share muted">
            {percent(bucket.count, chart.total)}
          </span>
        </div>
      ))}
      {chart.other && chart.other.count > 0
        ? <div className="muted" style={{ fontSize: "0.82rem" }}>
            + {number(chart.other.distinct)} {otherLabel || "more"} (
            {number(chart.other.count)} ·{" "}
            {percent(chart.other.count, chart.total)})
          </div>
        : null}
    </div>
  );
}

function MealsList({ meals }) {
  if (!meals.length) {
    return <p className="muted">No meals set up yet.</p>;
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
    return <p className="muted">No application rounds yet.</p>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="st-table">
        <thead>
          <tr>
            <th scope="col">Round</th>
            <th scope="col">Submitted</th>
            {STATUS_SERIES.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
            <th scope="col">Drafts</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((r) => (
            <tr key={r._id || "none"}>
              <td>{r.name}</td>
              <td>{number(r.total)}</td>
              {STATUS_SERIES.map((s) => (
                <td key={s.key}>{number(r.byStatus[s.key])}</td>
              ))}
              <td>{number(r.byStatus.draft)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Stacked columns, one per day, split by status. Hover or focus a day for the
// exact numbers; "View as table" has every value without hovering.
function TimeChart({ days, series, timeZone }) {
  const [hover, setHover] = useState(null);

  if (!days.length) {
    return <p className="muted">No applications yet.</p>;
  }

  const W = 720;
  const H = 240;
  const margin = { top: 12, right: 12, bottom: 28, left: 40 };
  const innerW = W - margin.left - margin.right;
  const innerH = H - margin.top - margin.bottom;
  const band = innerW / days.length;
  const barW = Math.max(2, Math.min(24, band - 4));

  const maxTotal = Math.max(1, ...days.map((d) => d.total));
  const step = niceStep(maxTotal);
  const yMax = step * Math.ceil(maxTotal / step);
  const ticks = [];
  for (let v = 0; v <= yMax; v += step) ticks.push(v);
  const y = (v) => margin.top + innerH - (v / yMax) * innerH;

  // Label about six days along the axis, and the last day too unless it would
  // crowd the label before it.
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
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
  const hoverLeft =
    hover === null ? 0 : ((margin.left + band * hover + band / 2) / W) * 100;

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: "1.1rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
          fontSize: "0.82rem",
        }}
      >
        {seriesTotals.map((s) => (
          <span
            key={s.key}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 10,
                height: 10,
                borderRadius: 3,
                background: s.color,
              }}
            />
            {s.label}
            <span className="muted">{number(s.total)}</span>
          </span>
        ))}
      </div>

      <div style={{ position: "relative" }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Applications per day, ${dayLabel(days[0].date)} to ${dayLabel(days[days.length - 1].date)}, split by status. A table with the same numbers follows.`}
        >
          <g className="st-grid">
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
          <g className="st-axis">
            {ticks.map((v) => (
              <text key={v} x={margin.left - 8} y={y(v) + 4} textAnchor="end">
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
            // A 2px surface-coloured gap separates stacked segments.
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
                      fill="var(--st-grid)"
                      opacity="0.45"
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
                      fill={p.color}
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

        {hovered
          ? <div
              className="card"
              style={{
                position: "absolute",
                top: 0,
                left: `${Math.min(86, Math.max(14, hoverLeft))}%`,
                transform: "translateX(-50%)",
                padding: "0.5rem 0.7rem",
                fontSize: "0.8rem",
                pointerEvents: "none",
                minWidth: 130,
              }}
            >
              <div className="muted" style={{ marginBottom: 2 }}>
                {dayLabel(hovered.date, true)}
              </div>
              <div style={{ fontWeight: 650, marginBottom: 4 }}>
                {number(hovered.total)} total
              </div>
              {series.map((s) => (
                <div
                  key={s.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 10,
                      height: 3,
                      borderRadius: 2,
                      background: s.color,
                    }}
                  />
                  <span style={{ fontWeight: 600 }}>
                    {number(hovered.byStatus[s.key])}
                  </span>
                  <span className="muted">{s.label}</span>
                </div>
              ))}
            </div>
          : null}
      </div>
      <p
        className="muted"
        style={{ fontSize: "0.78rem", marginTop: "0.25rem" }}
      >
        By the day the application was started, in{" "}
        {timeZone || "the event's time zone"}.
      </p>

      <details style={{ marginTop: "0.75rem" }}>
        <summary style={{ cursor: "pointer", fontSize: "0.85rem" }}>
          View as table
        </summary>
        <div style={{ overflowX: "auto", marginTop: "0.5rem" }}>
          <table className="st-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Total</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{dayLabel(d.date, true)}</td>
                  <td>{number(d.total)}</td>
                  {series.map((s) => (
                    <td key={s.key}>{number(d.byStatus[s.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// Downloads (B29). Personal data, so the card says so; the file comes from an
// authenticated request, since a plain link can't carry the login token.
function ExportsCard({ round, status }) {
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
    <Section title="Exports">
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "0.85rem" }}
      >
        These files contain personal information. Share them only with people
        who need them. The applications file follows the round and status chosen
        above.
      </p>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        {buttons.map(([name, label, path, fallback]) => (
          <button
            key={name}
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", gap: "0.4rem" }}
            disabled={Boolean(busy)}
            onClick={() => run(name, path, fallback)}
          >
            <Download size={16} aria-hidden="true" />
            {busy === name ? "Preparing…" : label}
          </button>
        ))}
      </div>

      <div
        style={{
          marginTop: "1.1rem",
          paddingTop: "1rem",
          borderTop: "1px solid var(--st-grid)",
        }}
      >
        <div
          style={{
            fontWeight: 600,
            fontSize: "0.9rem",
            marginBottom: "0.3rem",
          }}
        >
          Resumes for sponsors (ZIP)
        </div>
        <p
          className="muted"
          style={{ fontSize: "0.82rem", marginBottom: "0.6rem" }}
        >
          Accepted applicants who ticked the question below, and nobody else.
          The file can be large; keep this tab open until it finishes.
        </p>
        {consentQuestions.length === 0
          ? <p className="muted" style={{ fontSize: "0.85rem" }}>
              Add a checkbox question to the application form (for example
              &ldquo;Share my resume with sponsors&rdquo;) to use this.
            </p>
          : <div
              style={{
                display: "flex",
                gap: "0.6rem",
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <select
                className="select"
                aria-label="Question that says an applicant agreed to share their resume"
                style={{ maxWidth: 320 }}
                value={consentKey}
                onChange={(e) => setConsentKey(e.target.value)}
              >
                <option value="">Choose the consent question…</option>
                {consentQuestions.map((q) => (
                  <option key={q.key} value={q.key}>
                    {q.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto", gap: "0.4rem" }}
                disabled={Boolean(busy) || !consentKey}
                onClick={() =>
                  run(
                    "resumes",
                    `/api/admin/exports/resumes.zip?${resumeQuery.toString()}`,
                    "resumes.zip",
                  )
                }
              >
                <Download size={16} aria-hidden="true" />
                {busy === "resumes" ? "Preparing…" : "Download ZIP"}
              </button>
            </div>}
      </div>

      {error
        ? <div
            className="alert-error"
            role="alert"
            style={{ marginTop: "0.85rem" }}
          >
            {error}
          </div>
        : null}
    </Section>
  );
}
