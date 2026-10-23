"use client";

import { MailCheck } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

/**
 * Banner for accounts whose email isn't verified yet. The backend refuses
 * applications until it is, so this says why and lets people ask for another
 * link. Renders nothing for verified users.
 * @param {object} props - `{ user }` (the signed-in user).
 * @returns {JSX.Element|null}
 */
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
    <Alert variant="warning" aria-live="polite" className="mb-6">
      <MailCheck aria-hidden="true" />
      <AlertTitle className="font-medium">
        Verify your email to apply
      </AlertTitle>
      <AlertDescription className="space-y-3">
        <p>We sent a link to {user.email}. Open it, then refresh this page.</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-foreground"
            onClick={resend}
            loading={sending}
          >
            {sending ? "Sending" : "Resend email"}
          </Button>
          {message
            ? <span className="text-xs text-success">{message}</span>
            : null}
          {error
            ? <span role="alert" className="text-xs text-destructive">
                {error}
              </span>
            : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
