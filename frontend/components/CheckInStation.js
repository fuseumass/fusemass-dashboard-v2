"use client";

import { useRef, useState } from "react";
import QRScanner from "@/components/QRScanner";

// Shared pieces of the event-day scanning screens (first check-in and meals):
// the camera + code box, the big result banner, and the per-device log.

const RECENT_LIMIT = 8;

const RESULT_STYLES = {
  success: { color: "var(--success)", icon: "✓" },
  duplicate: { color: "#d97706", icon: "!" },
  error: { color: "var(--danger)", icon: "✕" },
};

export function formatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

/**
 * Turn a failed check-in request into a result: a 409 is "already done"
 * (with when/by whom), anything else is an error.
 * @param {Error} err - Error thrown by apiFetch (has status + data).
 * @returns {object} A result for useStationLog().record.
 */
export function resultFromError(err) {
  if (err.status === 409) {
    const by = err.data?.checkedInBy ? ` by ${err.data.checkedInBy}` : "";
    return {
      kind: "duplicate",
      attendee: err.data?.attendee,
      message: err.message,
      warning: `First checked in at ${formatTime(err.data?.checkedInAt)}${by}.`,
    };
  }
  return { kind: "error", message: err.message };
}

/**
 * The last result plus a short log of recent results on this device.
 * @returns {{result: object|null, recent: Array<object>, record: function, clear: function}}
 */
export function useStationLog() {
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const count = useRef(0);

  function record(next) {
    count.current += 1;
    const entry = { ...next, id: count.current, at: new Date() };
    setResult(entry);
    setRecent((list) => [entry, ...list].slice(0, RECENT_LIMIT));
  }

  return { result, recent, record, clear: () => setResult(null) };
}

/**
 * Camera scanner, a code box (also what a handheld USB scanner "types"
 * into), and the outcome of the last check-in.
 * @param {object} props
 * @param {string} props.title - Card heading.
 * @param {function(string): Promise<void>} props.onCode - Called with each scanned/typed code.
 * @param {object|null} props.result - Last result to show.
 */
export default function CheckInStation({ title, onCode, result }) {
  const [code, setCode] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    setCode("");
    await onCode(value);
  }

  return (
    <div className="card" style={{ padding: "1.5rem", marginBottom: "1rem" }}>
      <h2
        style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "1rem" }}
      >
        {title}
      </h2>

      <QRScanner onScan={onCode} />

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}
      >
        <input
          className="input"
          aria-label="Check-in code"
          placeholder="Or type / scan a code here"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-ghost"
          style={{ width: "auto", whiteSpace: "nowrap" }}
          disabled={!code.trim()}
        >
          Check in
        </button>
      </form>

      {result ? <ResultBanner result={result} /> : null}
    </div>
  );
}

// Big, color-coded outcome of the last scan, readable at arm's length.
function ResultBanner({ result }) {
  const style = RESULT_STYLES[result.kind];
  return (
    <div
      aria-live="polite"
      style={{
        marginTop: "1rem",
        padding: "1rem 1.25rem",
        borderRadius: 10,
        border: `2px solid ${style.color}`,
        background: `color-mix(in srgb, ${style.color} 10%, transparent)`,
      }}
    >
      <div style={{ fontSize: "1.2rem", fontWeight: 700, color: style.color }}>
        {style.icon} {result.message}
      </div>
      {result.attendee
        ? <div style={{ marginTop: 4 }}>
            <strong>{result.attendee.name}</strong>
            <span className="muted"> · {result.attendee.email}</span>
          </div>
        : null}
      {result.warning
        ? <div style={{ marginTop: 4, fontSize: "0.88rem" }}>
            {result.warning}
          </div>
        : null}
    </div>
  );
}

/**
 * Log of this device's recent check-ins.
 * @param {object} props
 * @param {Array<object>} props.recent - Entries from useStationLog().
 */
export function RecentScans({ recent }) {
  if (recent.length === 0) return null;
  return (
    <div className="card" style={{ padding: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Recent on this device
      </h2>
      {recent.map((entry) => (
        <div
          key={entry.id}
          style={{
            display: "flex",
            gap: "0.75rem",
            padding: "0.4rem 0",
            fontSize: "0.88rem",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span
            style={{
              color: RESULT_STYLES[entry.kind].color,
              fontWeight: 700,
              width: 14,
            }}
          >
            {RESULT_STYLES[entry.kind].icon}
          </span>
          <span className="muted" style={{ width: 70 }}>
            {formatTime(entry.at)}
          </span>
          <span>
            {entry.attendee ? `${entry.attendee.name}: ` : ""}
            {entry.message}
          </span>
        </div>
      ))}
    </div>
  );
}
