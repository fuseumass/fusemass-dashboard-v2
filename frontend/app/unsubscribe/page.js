"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthShell from "@/components/AuthShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
    <AuthShell
      title="Unsubscribe"
      footer={
        <Link href="/login" className="font-medium text-link hover:underline">
          Open the dashboard
        </Link>
      }
    >
      {done
        ? <Alert variant="success">
            <AlertDescription>
              You are unsubscribed from announcement emails. You will still get
              emails about your application, check-in and account.
            </AlertDescription>
          </Alert>
        : !userId || !token
          ? <Alert variant="destructive">
              <AlertDescription>
                This unsubscribe link is incomplete. Use the link from the
                email.
              </AlertDescription>
            </Alert>
          : <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                You will stop getting news and reminders. Emails about your
                application, check-in and account will keep coming.
              </p>
              {error
                ? <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                : null}
              <Button
                type="button"
                loading={submitting}
                onClick={handleUnsubscribe}
              >
                {submitting ? "Unsubscribing" : "Unsubscribe"}
              </Button>
            </div>}
    </AuthShell>
  );
}
