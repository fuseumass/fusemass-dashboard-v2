"use client";

import { KeyRound, QrCode, Search, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatTime } from "@/components/CheckInStation";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Attendee help (moderators + admins): look someone up by email, then resend
// their QR code email, send them an account setup / password reset link, or
// force-check them in.
export default function AttendeeHelpPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";

  const [email, setEmail] = useState("");
  const [attendee, setAttendee] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
  }, [isStaff, router]);

  if (!isStaff) return null;

  async function run(action, fn) {
    setError("");
    setNotice("");
    setBusy(action);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
      if (err.data?.attendee)
        setAttendee((a) => ({ ...a, ...err.data.attendee }));
    } finally {
      setBusy("");
    }
  }

  function lookUp(e) {
    e.preventDefault();
    run("lookup", async () => {
      setAttendee(null);
      const data = await apiFetch(
        `/api/staff/attendee?email=${encodeURIComponent(email.trim())}`,
      );
      setAttendee(data.attendee);
      setReason("");
    });
  }

  function resendQr() {
    run("qr", async () => {
      await apiFetch("/api/staff/attendee/resend-qr", {
        method: "POST",
        body: JSON.stringify({ email: attendee.email }),
      });
      setNotice(`QR code email sent to ${attendee.email}.`);
    });
  }

  function sendAccountLink() {
    run("link", async () => {
      const data = await apiFetch("/api/staff/attendee/send-account-link", {
        method: "POST",
        body: JSON.stringify({ email: attendee.email }),
      });
      setAttendee(data.attendee);
      setNotice(
        data.kind === "setup"
          ? `Account setup link sent to ${attendee.email} (works for 7 days).`
          : `Password reset link sent to ${attendee.email} (works for 1 hour).`,
      );
    });
  }

  function forceCheckIn(e) {
    e.preventDefault();
    run("checkin", async () => {
      const data = await apiFetch("/api/staff/checkin", {
        method: "POST",
        body: JSON.stringify({
          userId: attendee.id,
          force: true,
          reason: reason.trim(),
        }),
      });
      setAttendee((a) => ({
        ...a,
        checkedIn: true,
        checkedInAt: data.checkIn?.checkedInAt || new Date().toISOString(),
      }));
      setNotice(
        data.forced
          ? `${attendee.name} is checked in (forced).`
          : `${attendee.name} is checked in.`,
      );
    });
  }

  const accepted = attendee?.applicationStatus === "accepted";

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Attendee help
      </h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        Find someone by email to resend their QR code, send them a way into
        their account, or check them in by hand.
      </p>

      <form
        onSubmit={lookUp}
        className="card"
        style={{
          padding: "1.25rem",
          display: "flex",
          gap: "0.5rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <input
          className="input"
          type="email"
          aria-label="Attendee email"
          placeholder="attendee@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ flex: "1 1 240px" }}
        />
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto", gap: "0.4rem" }}
          disabled={busy === "lookup" || !email.trim()}
        >
          <Search size={16} aria-hidden="true" />
          {busy === "lookup" ? "Looking up…" : "Look up"}
        </button>
      </form>

      {error
        ? <div
            className="alert-error"
            role="alert"
            style={{ marginBottom: "1rem" }}
          >
            {error}
          </div>
        : null}
      {notice
        ? <div className="alert-success" style={{ marginBottom: "1rem" }}>
            {notice}
          </div>
        : null}

      {attendee
        ? <div className="card" style={{ padding: "1.25rem 1.5rem" }}>
            <h2 style={{ fontSize: "1.15rem", fontWeight: 700 }}>
              {attendee.name}
            </h2>
            <p className="muted" style={{ marginBottom: "0.75rem" }}>
              {attendee.email}
            </p>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "max-content 1fr",
                gap: "0.35rem 1rem",
                margin: "0 0 1.25rem",
              }}
            >
              <dt className="muted">Application</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>
                {attendee.applicationStatus === "none"
                  ? "Hasn't applied"
                  : attendee.applicationStatus}
              </dd>
              <dt className="muted">Checked in</dt>
              <dd style={{ margin: 0 }}>
                {attendee.checkedIn
                  ? `Yes, at ${formatTime(attendee.checkedInAt)}`
                  : "Not yet"}
              </dd>
              <dt className="muted">Account</dt>
              <dd style={{ margin: 0 }}>
                {attendee.accountReady
                  ? "Can sign in"
                  : "No password yet (applied without an account)"}
              </dd>
            </dl>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto", gap: "0.4rem" }}
                disabled={!accepted || busy === "qr"}
                title={
                  accepted
                    ? undefined
                    : "Only accepted applicants have a QR code"
                }
                onClick={resendQr}
              >
                <QrCode size={16} aria-hidden="true" />
                {busy === "qr" ? "Sending…" : "Resend QR code email"}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto", gap: "0.4rem" }}
                disabled={busy === "link"}
                onClick={sendAccountLink}
              >
                <KeyRound size={16} aria-hidden="true" />
                {busy === "link"
                  ? "Sending…"
                  : attendee.accountReady
                    ? "Send password reset link"
                    : "Send account setup link"}
              </button>
            </div>

            {attendee.checkedIn
              ? null
              : <form
                  onSubmit={forceCheckIn}
                  style={{
                    marginTop: "1.25rem",
                    paddingTop: "1rem",
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <label className="field-label" htmlFor="force-reason">
                    {accepted
                      ? "Check them in by hand (note why, e.g. lost their QR code)"
                      : `Force check-in: their application is ${attendee.applicationStatus === "none" ? "missing" : attendee.applicationStatus}, so note why`}
                  </label>
                  <div
                    style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                  >
                    <input
                      id="force-reason"
                      className="input"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason (at least 3 characters)"
                      minLength={3}
                      required
                      style={{ flex: "1 1 240px" }}
                    />
                    <button
                      type="submit"
                      className="btn btn-primary"
                      style={{ width: "auto", gap: "0.4rem" }}
                      disabled={busy === "checkin" || reason.trim().length < 3}
                    >
                      <UserCheck size={16} aria-hidden="true" />
                      {busy === "checkin" ? "Checking in…" : "Check in"}
                    </button>
                  </div>
                </form>}
          </div>
        : null}
    </div>
  );
}
