"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import CheckInStation, {
  formatTime,
  RecentScans,
  resultFromError,
  useStationLog,
} from "@/components/CheckInStation";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Moderators + admins: first check-in, when attendees arrive. Scanning an
// attendee's QR marks them checked in and emails them the Discord link, the
// website and the run of show (as a calendar invite). Meals have their own
// screen at /dashboard/staff/meals.
export default function StaffCheckInPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";
  const log = useStationLog();
  const [stats, setStats] = useState(null);

  const loadStats = useCallback(() => {
    apiFetch("/api/staff/checkin/stats")
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
  }, [isStaff, router]);

  useEffect(() => {
    if (isStaff) loadStats();
  }, [isStaff, loadStats]);

  if (!isStaff) return null;

  /**
   * @param {object} who - { qrId } from a scan, or { userId } from the search.
   * @returns {Promise<boolean>} Whether a new check-in was recorded.
   */
  async function checkIn(who) {
    try {
      const data = await apiFetch("/api/staff/checkin", {
        method: "POST",
        body: JSON.stringify(who),
      });
      log.record({
        kind: "success",
        attendee: data.attendee,
        message: "Checked in",
        warning: "Welcome email with Discord, website and schedule sent.",
      });
      loadStats();
      return true;
    } catch (err) {
      log.record(resultFromError(err));
      return false;
    }
  }

  const percent =
    stats?.accepted > 0
      ? Math.round((stats.checkedIn / stats.accepted) * 100)
      : 0;

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Check-in
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Scan attendees&apos; QR codes as they arrive.
      </p>

      {stats
        ? <div
            className="card"
            style={{ padding: "1.25rem 1.5rem", marginBottom: "1rem" }}
          >
            <div style={{ fontSize: "1.6rem", fontWeight: 700 }}>
              {stats.checkedIn}
              <span className="muted" style={{ fontSize: "1rem" }}>
                {" "}
                / {stats.accepted} checked in
              </span>
            </div>
            <div
              aria-hidden="true"
              style={{
                height: 8,
                borderRadius: 999,
                background: "var(--border)",
                marginTop: "0.6rem",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${percent}%`,
                  height: "100%",
                  background: "var(--brand)",
                }}
              />
            </div>
          </div>
        : null}

      <CheckInStation
        title="Scan"
        onCode={(code) => checkIn({ qrId: code })}
        result={log.result}
      />

      <AttendeeSearch onCheckIn={checkIn} />

      <RecentScans recent={log.recent} />
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
