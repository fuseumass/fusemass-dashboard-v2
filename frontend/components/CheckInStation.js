"use client";

import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import QRScanner from "@/components/QRScanner";

// Shared pieces of the event-day scanning screens (first check-in and meals):
// the camera + code box, the big result banner, and the per-device log.

const RECENT_LIMIT = 8;

// A check-in code is SHA-256 of the attendee's email: 64 hex characters.
const FULL_CODE = /^[a-f0-9]{64}$/i;

// Laptops/desktops (mouse or trackpad): keep the code box focused so a USB
// scanner "typing" a code just works. Not on phones/tablets, where focusing
// would pop up the keyboard over the camera.
function hasFinePointer() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches
  );
}

const RESULT_STYLES = {
  success: { color: "var(--success)", icon: CircleCheck },
  duplicate: { color: "var(--warning)", icon: CircleAlert },
  error: { color: "var(--destructive)", icon: CircleX },
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
 * Camera scanner ("Open camera", for phones and tablets), a code box for
 * handheld USB/Bluetooth scanners (they act as keyboards), and the outcome of
 * the last check-in.
 * @param {object} props
 * @param {string} props.title - Card heading.
 * @param {function(string): Promise<void>} props.onCode - Called with each scanned/typed code.
 * @param {object|null} props.result - Last result to show; may carry an
 *   `action: { label, onClick }` button (e.g. "Force check-in").
 */
export default function CheckInStation({ title, onCode, result }) {
  const [code, setCode] = useState("");
  const inputRef = useRef(null);
  const busyRef = useRef(false);

  function refocus() {
    if (hasFinePointer()) inputRef.current?.focus();
  }

  useEffect(() => {
    if (hasFinePointer()) inputRef.current?.focus();
  }, []);

  async function submit(value) {
    const trimmed = value.trim();
    if (!trimmed || busyRef.current) return;
    busyRef.current = true;
    setCode("");
    try {
      await onCode(trimmed);
    } finally {
      busyRef.current = false;
      refocus();
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    submit(code);
  }

  function handleChange(e) {
    const value = e.target.value;
    // Scanners that end with Tab (or nothing) instead of Enter: a complete
    // code submits itself.
    if (FULL_CODE.test(value.trim())) {
      submit(value);
      return;
    }
    setCode(value);
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
          ref={inputRef}
          className="input"
          aria-label="Check-in code"
          placeholder="Or scan with a USB scanner / paste the code"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={code}
          onChange={handleChange}
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
      {result?.kind === "success" && result.popup?.length
        ? <CheckInPopup key={result.id} rows={result.popup} />
        : null}
    </div>
  );
}

// After a successful check-in: the attendee's name, pronouns, shirt size (or
// whatever admins chose in Settings) in large type. It never takes focus, so a
// USB scanner keeps typing into the code box: the next scan simply replaces
// it. Escape, a click, or "Done" closes it.
function CheckInPopup({ rows }) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <div
      aria-live="polite"
      onPointerDown={() => setOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "12vh",
        background: "var(--overlay)",
      }}
    >
      <div
        className="card"
        style={{
          padding: "1.75rem 2rem",
          minWidth: "min(420px, 92vw)",
          maxWidth: "92vw",
          borderTop: "6px solid var(--success)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--success)",
            fontWeight: 700,
            marginBottom: "1rem",
          }}
        >
          <CircleCheck size={22} aria-hidden="true" />
          Checked in
        </div>
        <dl style={{ display: "grid", gap: "0.9rem", margin: 0 }}>
          {rows.map((row) => (
            <div key={row.key}>
              <dt className="muted" style={{ fontSize: "0.85rem" }}>
                {row.label}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontSize: "1.9rem",
                  fontWeight: 700,
                  lineHeight: 1.15,
                  overflowWrap: "anywhere",
                }}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: "1.25rem" }}
          onClick={() => setOpen(false)}
        >
          Done
        </button>
      </div>
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
        <style.icon
          size={22}
          aria-hidden="true"
          style={{ verticalAlign: "-4px" }}
        />{" "}
        {result.message}
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
      {result.action
        ? <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", marginTop: "0.6rem" }}
            onClick={result.action.onClick}
          >
            {result.action.label}
          </button>
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
            {(() => {
              const Icon = RESULT_STYLES[entry.kind].icon;
              return <Icon size={14} aria-hidden="true" />;
            })()}
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
