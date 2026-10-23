"use client";

import { Flag } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";

// A small marker for flagged applications in the review table.
export function FlagBadge() {
  return (
    <span title="Flagged for a closer look" className="inline-flex">
      <Flag className="size-3.5 text-warning" aria-hidden="true" />
      <span className="sr-only">Flagged</span>
    </span>
  );
}

// In the review drawer: why an application is flagged (and by whom), with
// moderator controls to flag it with a reason or clear the flag. `onChanged`
// receives the updated application from the API.
export function FlagPanel({ app, onChanged }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(method, body) {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`/api/admin/applications/${app._id}/flag`, {
        method,
        body,
      });
      setReason("");
      onChanged(data.application);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      {app.flagged
        ? <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 font-medium">
                <Flag className="size-3.5 text-warning" aria-hidden="true" />
                Flagged
                {app.flaggedBy?.name ? ` by ${app.flaggedBy.name}` : ""}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => send("DELETE")}
              >
                Clear flag
              </Button>
            </div>
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {(app.flagReasons || []).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        : <p className="text-muted-foreground">Not flagged.</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) send("POST", JSON.stringify({ reason }));
        }}
        className="flex gap-2"
      >
        <Input
          className="h-8"
          value={reason}
          maxLength={300}
          placeholder={app.flagged ? "Add another reason" : "Reason to flag"}
          aria-label="Reason to flag"
          onChange={(e) => setReason(e.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy || !reason.trim()}
        >
          Flag
        </Button>
      </form>
      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
    </div>
  );
}
