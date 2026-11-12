"use client";

import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { notifyError, notifySuccess } from "@/lib/notify";

const PRESETS = ["Duplicate application", "Test application"];

// A small marker for removed applications in the review table.
export function RemovedBadge() {
  return <Badge variant="outline">Removed</Badge>;
}

// Asks for the reason, then marks the application removed. Nothing is deleted:
// the application and the account stay, and Restore undoes it.
// `onRemoved` receives the updated application from the API.
export function RemoveDialog({ app, name, open, onOpenChange, onRemoved }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    if (!reason.trim()) {
      setError("Enter a reason.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`/api/admin/applications/${app._id}/remove`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      notifySuccess("Application removed");
      setReason("");
      onOpenChange(false);
      onRemoved(data.application);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>Remove application</DialogTitle>
            <DialogDescription>
              {name}'s application stops counting in stats, exports, email
              lists, check-in and team building. Nothing is deleted, and you can
              restore it later.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="remove-reason">Reason</Label>
            <Input
              id="remove-reason"
              value={reason}
              maxLength={300}
              placeholder="Why is it being removed"
              onChange={(e) => setReason(e.target.value)}
              aria-invalid={Boolean(error)}
            />
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setReason(preset)}
                >
                  {preset}
                </Button>
              ))}
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={busy}>
              <Trash2 aria-hidden="true" />
              Remove application
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// At the top of the drawer for a removed application: the reason, who and
// when, a link to the application it duplicates, and Restore.
export function RemovedNotice({ app, onRestored, onOpenOther }) {
  const [busy, setBusy] = useState(false);

  async function restore() {
    setBusy(true);
    try {
      const data = await apiFetch(
        `/api/admin/applications/${app._id}/restore`,
        { method: "POST" },
      );
      notifySuccess("Application restored");
      onRestored(data.application);
    } catch (err) {
      notifyError(err, { title: "Couldn't restore the application" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Alert variant="warning" aria-live="polite">
      <Trash2 aria-hidden="true" />
      <AlertDescription className="space-y-2">
        <p className="font-medium">Removed</p>
        <p>
          {(app.removedReason || "No reason recorded.").replace(/\.?$/, ".")}
          {app.removedBy?.name || app.removedAt
            ? ` Removed${app.removedBy?.name ? ` by ${app.removedBy.name}` : ""}${app.removedAt ? ` on ${formatDateTime(app.removedAt)}` : ""}.`
            : ""}
        </p>
        {app.duplicateOf?._id
          ? <p>
              Duplicate of{" "}
              <button
                type="button"
                className="text-link underline"
                onClick={() => onOpenOther(app.duplicateOf._id)}
              >
                {app.duplicateOf.name || "another application"}
              </button>
            </p>
          : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={busy}
          onClick={restore}
        >
          <RotateCcw aria-hidden="true" />
          Restore application
        </Button>
      </AlertDescription>
    </Alert>
  );
}
