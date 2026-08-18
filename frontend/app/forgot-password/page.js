"use client";

import Link from "next/link";
import { useState } from "react";
import AuthShell from "@/components/AuthShell";
import { apiFetch } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    //Richarla - edit start
    
if (!email.trim() || !email.includes("@")){
  setError("Please enter a valid email address.");
  setSubmitting(false);
  return;
}

    //Richarla - edit end
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We'll email you a link to set a new password"
    >
      {sent
        ? <div className="alert-success">
            If an account exists for that email, a reset link is on its way.
            Check your inbox.
          </div>
        : <form
            onSubmit={handleSubmit}
            style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}
          >
            <div>
              <label className="field-label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>

            {error
              ? <div className="alert-error" role="alert">
                  {error}
                </div>
              : null}

            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? "Sending…" : "Send reset link"}
            </button>
          </form>}

      <p
        className="muted"
        style={{
          textAlign: "center",
          marginTop: "1.25rem",
          fontSize: "0.9rem",
        }}
      >
        <Link href="/login" className="link">
          Back to log in
        </Link>
      </p>
    </AuthShell>
  );
}
