"use client";

import { Check } from "lucide-react";
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
// attendee's QR (camera on a phone/tablet, or a USB scanner into the code box)
// marks them checked in and emails them the Discord link, the website and the
// run of show (as a calendar invite). "Force check-in" covers people whose
// application isn't accepted. Meals have their own screen at
// /dashboard/staff/meals.

const STATUS_LABELS = {
  accepted: "Accepted",
  pending: "Pending review",
  waitlisted: "Waitlisted",
  rejected: "Rejected",
  draft: "Draft (not submitted)",
  none: "No application",
};
export default function StaffCheckInPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";
  const log = useStationLog();
  const [stats, setStats] = useState(null);
  // Forced check-in panel: closed (null), open with no one picked ({}), or
  // open for a specific person ({ attendee }).
  const [force, setForce] = useState(null);

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
        message: data.forced ? "Checked in (forced)" : "Checked in",
        warning: "Welcome email with Discord, website and schedule sent.",
        popup: data.popup,
      });
      loadStats();
      return true;
    } catch (err) {
      const result = resultFromError(err);
      // Not accepted: offer a forced check-in for exactly this person.
      if (err.data?.code === "not_accepted" && err.data.attendee) {
        result.action = {
          label: "Force check-in instead…",
          onClick: () => setForce({ attendee: err.data.attendee }),
        };
      }
      log.record(result);
      return false;
    }
  }

  async function forceCheckIn(attendee, reason) {
    const ok = await checkIn({ userId: attendee.id, force: true, reason });
    if (ok) setForce(null);
    return ok;
  }

  const percent =
    stats?.accepted > 0
      ? Math.round((stats.checkedIn / stats.accepted) * 100)
      : 0;

  return (
    <div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
          marginBottom: "1.5rem",
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
            Check-in
          </h1>
          <p className="muted">Scan attendees&apos; QR codes as they arrive.</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto" }}
          onClick={() => setForce(force ? null : {})}
        >
          {force ? "Close forced check-in" : "Force check-in"}
        </button>
      </div>

      {force
        ? <ForceCheckInPanel
            initial={force.attendee || null}
            onSubmit={forceCheckIn}
            onClose={() => setForce(null)}
          />
        : null}

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
                {stats.forced ? ` · ${stats.forced} forced` : ""}
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

// Forced check-in: check in someone whose application isn't accepted (or who
// never applied), e.g. an approved walk-in. Pick the person (pre-filled after a
// refused scan, or searched across everyone), give a reason, confirm.
function ForceCheckInPanel({ initial, onSubmit, onClose }) {
  const [target, setTarget] = useState(initial);
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTarget(initial);
  }, [initial]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setPeople([]);
      return;
    }
    const handle = setTimeout(() => {
      apiFetch(`/api/staff/attendees?all=1&q=${encodeURIComponent(q)}`)
        .then((data) => setPeople(data.attendees || []))
        .catch((err) => setError(err.message));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!target || reason.trim().length < 3) return;
    setSubmitting(true);
    setError("");
    const ok = await onSubmit(target, reason.trim());
    setSubmitting(false);
    if (!ok) setError("The check-in didn't go through. See the result below.");
  }

  return (
    <form
      className="card"
      onSubmit={handleSubmit}
      style={{
        padding: "1.5rem",
        marginBottom: "1rem",
        borderColor: "var(--warning)",
      }}
    >
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.25rem",
        }}
      >
        Force check-in
      </h2>
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        Checks in someone whose application isn&apos;t accepted. Your name and
        the reason are recorded with the check-in.
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}

      {target
        ? <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "0.75rem",
              padding: "0.75rem",
              border: "1px solid var(--border)",
              borderRadius: 10,
              marginBottom: "0.75rem",
            }}
          >
            <div>
              <div style={{ fontWeight: 600 }}>{target.name}</div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {target.email} ·{" "}
                {STATUS_LABELS[target.applicationStatus] ||
                  target.applicationStatus}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto" }}
              onClick={() => setTarget(null)}
            >
              Change
            </button>
          </div>
        : <div style={{ marginBottom: "0.75rem" }}>
            <input
              className="input"
              aria-label="Search everyone by name or email"
              placeholder="Search everyone by name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {people.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => setTarget(p)}
                disabled={p.checkedIn}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  width: "100%",
                  textAlign: "left",
                  gap: "0.75rem",
                  padding: "0.6rem 0.25rem",
                  background: "none",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  color: "inherit",
                  cursor: p.checkedIn ? "default" : "pointer",
                }}
              >
                <span>
                  <strong>{p.name}</strong>
                  <span className="muted"> · {p.email}</span>
                </span>
                <span className="muted" style={{ fontSize: "0.82rem" }}>
                  {p.checkedIn
                    ? "Already checked in"
                    : STATUS_LABELS[p.applicationStatus] || p.applicationStatus}
                </span>
              </button>
            ))}
          </div>}

      <label className="field-label" htmlFor="force-reason">
        Reason (required)
      </label>
      <textarea
        id="force-reason"
        className="textarea"
        rows={2}
        placeholder="e.g. Walk-in approved by the lead organizer"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto" }}
          disabled={!target || reason.trim().length < 3 || submitting}
        >
          {submitting
            ? "Checking in…"
            : target
              ? `Force check-in ${target.name}`
              : "Pick someone first"}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto" }}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </form>
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
                      <Check
                        size={14}
                        aria-hidden="true"
                        style={{ verticalAlign: "-2px" }}
                      />{" "}
                      Checked in {formatTime(a.checkedInAt)}
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
