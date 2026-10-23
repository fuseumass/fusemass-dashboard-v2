"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { apiFetch, getToken } from "@/lib/api";

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  );
}

// Landing page for the link in the verification email. The token is sent with
// a POST from here rather than verified by a GET on the link itself, so mail
// scanners that prefetch links can't use it up.
function VerifyInner() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [status, setStatus] = useState(token ? "working" : "failed");
  const [error, setError] = useState(
    token ? "" : "This verification link is missing its token or is malformed.",
  );
  // The link works once, and React runs effects twice in development, so make
  // sure only one request is ever sent.
  const started = useRef(false);

  useEffect(() => {
    if (!token || started.current) {
      return;
    }
    started.current = true;
    apiFetch("/api/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(() => setStatus("done"))
      .catch((err) => {
        setError(err.message);
        setStatus("failed");
      });
  }, [token]);

  const loggedIn = status !== "working" && Boolean(getToken());
  let linkLabel = "Log in to request a new link";
  if (status === "done") {
    linkLabel = loggedIn ? "Go to your dashboard" : "Log in";
  } else if (loggedIn) {
    linkLabel = "Back to your dashboard to request a new link";
  }

  return (
    <AuthShell title="Verify your email">
      {status === "working"
        ? <p className="muted" style={{ textAlign: "center" }}>
            Verifying your email…
          </p>
        : null}

      {status === "done"
        ? <div className="alert-success" aria-live="polite">
            Your email address is verified. You can now apply.
          </div>
        : null}

      {status === "failed"
        ? <div className="alert-error" role="alert">
            {error}
          </div>
        : null}

      {status === "working"
        ? null
        : <p
            className="muted"
            style={{
              textAlign: "center",
              marginTop: "1.25rem",
              fontSize: "0.9rem",
            }}
          >
            <Link href={loggedIn ? "/dashboard" : "/login"} className="link">
              {linkLabel}
            </Link>
          </p>}
    </AuthShell>
  );
}
