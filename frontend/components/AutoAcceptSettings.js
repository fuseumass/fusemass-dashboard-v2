"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";

// Settings card for domain auto-accept (backend utils/autoAccept): accept
// pending applicants from email domains like umass.edu a few at a time, at
// most N per day, so the acceptance emails stay under the sending account's
// limit. Saved with PATCH /api/admin/settings { autoAccept }.

function domainsText(domains) {
  return (domains || []).join(", ");
}

function hours(n) {
  if (n <= 1) return "about an hour";
  if (n < 48) return `about ${n} hours`;
  return `about ${Math.round(n / 24)} days`;
}

export default function AutoAcceptSettings() {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    return apiFetch("/api/admin/auto-accept")
      .then((data) => {
        setStatus(data);
        setForm({
          enabled: data.enabled,
          domains: domainsText(data.domains),
          includeSubdomains: data.includeSubdomains,
          emailsPerDay: String(data.emailsPerDay || 200),
        });
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Preview whatever is typed, so the numbers match before saving.
  useEffect(() => {
    if (!form) return undefined;
    const timer = setTimeout(() => {
      if (!form.domains.trim()) {
        setPreview(null);
        return;
      }
      apiFetch("/api/admin/auto-accept/preview", {
        method: "POST",
        body: JSON.stringify({
          domains: form.domains,
          includeSubdomains: form.includeSubdomains,
          emailsPerDay: Number(form.emailsPerDay) || 1,
        }),
      })
        .then((data) => {
          setPreview(data);
          setError("");
        })
        .catch((err) => {
          setPreview(null);
          setError(err.message);
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [form]);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function save() {
    setSaving(true);
    setConfirming(false);
    return apiFetch("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        autoAccept: {
          enabled: form.enabled,
          domains: form.domains,
          includeSubdomains: form.includeSubdomains,
          emailsPerDay: Number(form.emailsPerDay),
        },
      }),
    })
      .then(() => {
        notifySuccess(
          form.enabled ? "Auto-accept is on." : "Auto-accept settings saved.",
        );
        return load();
      })
      .catch((err) => notifyError(err))
      .finally(() => setSaving(false));
  }

  function handleSave() {
    // Switching it on starts accepting real people: confirm first.
    if (form.enabled && !status.enabled) {
      setConfirming(true);
      return;
    }
    save();
  }

  if (!form) {
    return error
      ? <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      : null;
  }

  const perDay = Number(form.emailsPerDay) || 0;
  const serverLimit = status.serverEmailLimit;
  const overServerLimit = serverLimit > 0 && perDay > serverLimit;
  const lastRun = status.enabled ? status.lastRun : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Auto-accept by email domain</CardTitle>
        <CardDescription>
          Accept pending applicants whose email is at these domains, a few at a
          time, so acceptance emails stay under your sending limit. Flagged
          applications are never auto-accepted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="auto-accept-enabled" className="flex-col items-start">
            <span>Auto-accept</span>
            <span className="text-xs font-normal text-muted-foreground">
              {status.enabled
                ? `On. ${status.acceptedLast24h} accepted in the last 24 hours, ${status.acceptedTotal} in total.`
                : "Off"}
            </span>
          </Label>
          <Switch
            id="auto-accept-enabled"
            checked={form.enabled}
            onCheckedChange={(value) => update("enabled", value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <div className="space-y-2">
            <Label htmlFor="auto-accept-domains">Email domains</Label>
            <Input
              id="auto-accept-domains"
              placeholder="umass.edu, smith.edu"
              value={form.domains}
              onChange={(event) => update("domains", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Separate with commas. The @ is optional.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="auto-accept-per-day">Emails per day</Label>
            <Input
              id="auto-accept-per-day"
              type="number"
              min={1}
              inputMode="numeric"
              className="tabular-nums"
              value={form.emailsPerDay}
              onChange={(event) => update("emailsPerDay", event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              One acceptance is one email.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label
            htmlFor="auto-accept-subdomains"
            className="flex-col items-start"
          >
            <span>Include subdomains</span>
            <span className="text-xs font-normal text-muted-foreground">
              umass.edu also matches cs.umass.edu.
            </span>
          </Label>
          <Switch
            id="auto-accept-subdomains"
            checked={form.includeSubdomains}
            onCheckedChange={(value) => update("includeSubdomains", value)}
          />
        </div>

        {preview
          ? <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <p>
                <span className="font-medium tabular-nums">
                  {preview.pending}
                </span>{" "}
                pending{" "}
                {preview.pending === 1
                  ? "application matches"
                  : "applications match"}
                .
                {preview.pending > 0
                  ? ` At ${preview.perHour} an hour, that takes ${hours(preview.hoursToFinish)}.`
                  : ""}
                {preview.flaggedSkipped > 0
                  ? ` ${preview.flaggedSkipped} flagged ${preview.flaggedSkipped === 1 ? "one is" : "ones are"} skipped.`
                  : ""}
              </p>
              {preview.sample.length > 0
                ? <p className="mt-1 text-muted-foreground">
                    Next in line:{" "}
                    {preview.sample
                      .slice(0, 5)
                      .map((row) => row.email)
                      .join(", ")}
                    {preview.pending > 5 ? ", …" : ""}
                  </p>
                : null}
            </div>
          : null}

        {overServerLimit
          ? <Alert variant="warning">
              <AlertDescription>
                The server allows {serverLimit} emails per 24 hours for
                everything combined, so auto-accept will pause when that runs
                out. Raise EMAIL_DAILY_LIMIT only if your email provider allows
                more.
              </AlertDescription>
            </Alert>
          : null}
        {!status.emailConfigured
          ? <Alert variant="warning">
              <AlertDescription>
                Email isn't set up on the server, so auto-accept won't accept
                anyone (they'd never get their acceptance email).
              </AlertDescription>
            </Alert>
          : null}
        {lastRun?.note
          ? <p className="text-sm text-muted-foreground">{lastRun.note}</p>
          : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
      <CardFooter className="justify-between gap-4 border-t">
        <p className="text-xs text-muted-foreground">
          {serverLimit > 0
            ? `The server sends at most ${serverLimit} emails per 24 hours, all emails together (${status.serverEmailsLast24h} so far).`
            : "The server has no daily email limit set."}
        </p>
        <Button onClick={handleSave} loading={saving}>
          Save
        </Button>
      </CardFooter>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on auto-accept?</AlertDialogTitle>
            <AlertDialogDescription>
              {preview
                ? `${preview.pending} pending ${preview.pending === 1 ? "applicant" : "applicants"} from ${preview.domains.join(", ")} will be accepted and emailed, at most ${perDay} a day. New applicants from these domains are accepted as they apply. Turning it off later doesn't undo acceptances.`
                : "Matching applicants will be accepted and emailed. Turning it off later doesn't undo acceptances."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={save}>Turn on</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
