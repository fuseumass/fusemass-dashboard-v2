"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

// "Check your inbox" banner for accounts whose email isn't verified yet. The
// backend refuses applications until it is, so this says why and lets people
// ask for another link. Renders nothing for verified users.
export default function VerifyEmailNotice({ user }) {
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  if (!user || user.emailVerified !== false) {
    return null;
  }

  async function resend() {
    setSending(true);
    setMessage("");
    setError("");
    try {
      const data = await apiFetch("/api/auth/resend-verification", {
        method: "POST",
      });
      setMessage(data.message || "Verification email sent.");
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="card"
      aria-live="polite"
      style={{ padding: "1rem 1.25rem", marginBottom: "1.25rem" }}
    >
      <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
        Check your inbox to verify your email
      </p>
      <p
        className="muted"
        style={{ fontSize: "0.9rem", marginBottom: "0.75rem" }}
      >
        We sent a link to {user.email}. You need to verify your email before you
        can apply. Already did? Refresh this page.
      </p>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={resend}
        disabled={sending}
      >
        {sending ? "Sending…" : "Resend verification email"}
      </button>
      {message
        ? <div className="alert-success" style={{ marginTop: "0.75rem" }}>
            {message}
          </div>
        : null}
      {error
        ? <div
            className="alert-error"
            role="alert"
            style={{ marginTop: "0.75rem" }}
          >
            {error}
          </div>
        : null}
    </div>
  );
}
