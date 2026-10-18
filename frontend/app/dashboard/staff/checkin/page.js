"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import QRScanner from "@/components/QRScanner";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const EVENT_STATION = "event";
const RECENT_LIMIT = 8;

const RESULT_STYLES = {
  success: { color: "var(--success)", icon: "✓" },
  duplicate: { color: "#d97706", icon: "!" },
  error: { color: "var(--danger)", icon: "✕" },
};

function formatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

// Moderators + admins: the event-day check-in station. Pick what this device
// is checking people into (the event itself, or one of the active meals),
// then scan attendees' QR codes. A handheld scanner works too: it "types" the
// code into the code box and presses Enter.
export default function StaffCheckInPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";

  const [meals, setMeals] = useState([]);
  const [station, setStation] = useState(EVENT_STATION);
  const [code, setCode] = useState("");
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const [loadError, setLoadError] = useState("");
  const resultCount = useRef(0);

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
  }, [isStaff, router]);

  useEffect(() => {
    if (!isStaff) return;
    apiFetch("/api/staff/meals")
      .then((data) => setMeals((data.meals || []).filter((m) => m.active)))
      .catch((err) => setLoadError(err.message));
  }, [isStaff]);

  if (!isStaff) return null;

  const meal = meals.find((m) => m._id === station) || null;

  function showResult(next) {
    resultCount.current += 1;
    const entry = { ...next, id: resultCount.current, at: new Date() };
    setResult(entry);
    setRecent((list) => [entry, ...list].slice(0, RECENT_LIMIT));
  }

  /**
   * Check the attendee in at the current station.
   * @param {object} who - { qrId } from a scan, or { userId } from the search.
   * @returns {Promise<boolean>} Whether a new check-in was recorded.
   */
  async function checkIn(who) {
    const path = meal
      ? `/api/staff/meals/${meal._id}/checkin`
      : "/api/staff/checkin";
    try {
      const data = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify(who),
      });
      if (meal) {
        setMeals((list) =>
          list.map((m) =>
            m._id === meal._id
              ? { ...m, checkInCount: (m.checkInCount || 0) + 1 }
              : m,
          ),
        );
      }
      showResult({
        kind: "success",
        attendee: data.attendee,
        message: meal ? `Served ${meal.name}` : "Checked in",
        warning:
          meal && !data.attendee.eventCheckedIn
            ? "Not checked in to the event yet. Send them to the check-in desk."
            : "",
      });
      return true;
    } catch (err) {
      if (err.status === 409) {
        const by = err.data?.checkedInBy ? ` by ${err.data.checkedInBy}` : "";
        showResult({
          kind: "duplicate",
          attendee: err.data?.attendee,
          message: err.message,
          warning: `First checked in at ${formatTime(err.data?.checkedInAt)}${by}.`,
        });
      } else {
        showResult({ kind: "error", message: err.message });
      }
      return false;
    }
  }

  function handleScan(text) {
    return checkIn({ qrId: text });
  }

  async function handleCodeSubmit(e) {
    e.preventDefault();
    const value = code.trim();
    if (!value) return;
    setCode("");
    await checkIn({ qrId: value });
  }

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Check-in
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Scan attendees&apos; QR codes for event check-in and meals.
      </p>

      {loadError
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {loadError}
          </div>
        : null}

      <div className="card" style={{ padding: "1.5rem", marginBottom: "1rem" }}>
        <label className="field-label" htmlFor="station">
          Checking people into
        </label>
        <select
          id="station"
          className="select"
          style={{ maxWidth: 420 }}
          value={station}
          onChange={(e) => {
            setStation(e.target.value);
            setResult(null);
          }}
        >
          <option value={EVENT_STATION}>Event check-in (first arrival)</option>
          {meals.map((m) => (
            <option key={m._id} value={m._id}>
              {m.name} ({m.checkInCount || 0} served)
            </option>
          ))}
        </select>
        {meals.length === 0 && !loadError
          ? <p
              className="muted"
              style={{ fontSize: "0.82rem", marginTop: "0.5rem" }}
            >
              No active meals. An admin can set them up under Meals.
            </p>
          : null}
      </div>

      <div className="card" style={{ padding: "1.5rem", marginBottom: "1rem" }}>
        <h2
          style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "1rem" }}
        >
          Scan
        </h2>

        <QRScanner onScan={handleScan} />

        <form
          onSubmit={handleCodeSubmit}
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

      {meal ? null : <AttendeeSearch onCheckIn={checkIn} />}

      {recent.length > 0
        ? <div className="card" style={{ padding: "1.5rem" }}>
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
        : null}
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

// Fallback for attendees without their QR code: find them by name or email.
function AttendeeSearch({ onCheckIn }) {
  const [query, setQuery] = useState("");
  const [attendees, setAttendees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setAttendees([]);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      apiFetch(`/api/staff/attendees?q=${encodeURIComponent(q)}`)
        .then((data) => {
          setAttendees(data.attendees || []);
          setError("");
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  async function handleCheckIn(attendee) {
    setPendingId(attendee.id);
    const ok = await onCheckIn({ userId: attendee.id });
    if (ok) {
      setAttendees((list) =>
        list.map((a) =>
          a.id === attendee.id
            ? { ...a, checkedIn: true, checkedInAt: new Date().toISOString() }
            : a,
        ),
      );
    }
    setPendingId(null);
  }

  return (
    <div className="card" style={{ padding: "1.5rem", marginBottom: "1rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.25rem",
        }}
      >
        No QR code?
      </h2>
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        Search accepted attendees by name or email. Check their ID first.
      </p>

      <input
        className="input"
        aria-label="Search attendees by name or email"
        placeholder="Search by name or email"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ marginBottom: "0.75rem" }}
      />

      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}

      {loading && attendees.length === 0
        ? <p className="muted">Searching…</p>
        : query.trim() && attendees.length === 0
          ? <p className="muted">No accepted attendees match.</p>
          : attendees.map((a) => (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.75rem",
                  flexWrap: "wrap",
                  padding: "0.65rem 0",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{a.name}</div>
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {a.email}
                  </div>
                </div>
                {a.checkedIn
                  ? <div
                      className="muted"
                      style={{ fontSize: "0.82rem", textAlign: "right" }}
                    >
                      ✓ Checked in {formatTime(a.checkedInAt)}
                      {a.checkedInBy ? ` by ${a.checkedInBy}` : ""}
                    </div>
                  : <button
                      type="button"
                      className="btn btn-primary"
                      style={{ width: "auto", whiteSpace: "nowrap" }}
                      disabled={pendingId === a.id}
                      onClick={() => handleCheckIn(a)}
                    >
                      {pendingId === a.id ? "Checking in…" : "Check in"}
                    </button>}
              </div>
            ))}
    </div>
  );
}
