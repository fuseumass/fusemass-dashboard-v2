"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
    linkLabel = loggedIn ? "Open your dashboard" : "Log in";
  } else if (loggedIn) {
    linkLabel = "Open your dashboard to request a new link";
  }

  return (
    <AuthShell title="Verify your email">
      {status === "working"
        ? <output className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Checking your link
          </output>
        : null}

      {status === "done"
        ? <Alert variant="success" aria-live="polite">
            <AlertDescription>
              Your email address is verified. You can now apply.
            </AlertDescription>
          </Alert>
        : null}

      {status === "failed"
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}

      {status === "working"
        ? null
        : <Button asChild className="w-full">
            <Link href={loggedIn ? "/dashboard" : "/login"}>{linkLabel}</Link>
          </Button>}
    </AuthShell>
  );
}
