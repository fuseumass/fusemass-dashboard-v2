"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { apiFetch } from "@/lib/api";

export default function UnsubscribePage() {
  return (
    <Suspense fallback={null}>
      <UnsubscribeInner />
    </Suspense>
  );
}

// Landing page for the "Unsubscribe" link at the bottom of announcement
// emails. It asks for a click and then POSTs, so a mail scanner that merely
// opens the link can't unsubscribe anyone by accident.
function UnsubscribeInner() {
  const params = useSearchParams();
  const userId = params.get("u") || "";
  const token = params.get("t") || "";

  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleUnsubscribe() {
    setError("");
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ u: userId, t: token }),
      });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell title="Unsubscribe" subtitle="Stop getting announcement emails">
      {done
        ? <div className="alert-success">
            You're unsubscribed from announcement emails. You'll still get
            emails about your application, check-in and account.
          </div>
        : !userId || !token
          ? <div className="alert-error" role="alert">
              This unsubscribe link is incomplete. Use the link from the email.
            </div>
          : <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.9rem",
              }}
            >
              <p className="muted" style={{ fontSize: "0.9rem" }}>
                You'll stop getting news and reminders. Emails about your
                application, check-in and account will keep coming.
              </p>
              {error
                ? <div className="alert-error" role="alert">
                    {error}
                  </div>
                : null}
              <button
                type="button"
                className="btn btn-primary"
                disabled={submitting}
                onClick={handleUnsubscribe}
              >
                {submitting ? "Unsubscribing…" : "Unsubscribe"}
              </button>
            </div>}

      <p
        className="muted"
        style={{
          textAlign: "center",
          marginTop: "1.25rem",
          fontSize: "0.9rem",
        }}
      >
        <Link href="/login" className="link">
          Go to the dashboard
        </Link>
      </p>
    </AuthShell>
  );
}
