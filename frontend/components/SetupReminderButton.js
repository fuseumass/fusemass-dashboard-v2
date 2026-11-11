"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";
import { number } from "@/components/StatsParts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";

// "Remind accepted people to set up their account" (admin User groups page).
// Opens with the count, then on confirm the server issues each person a
// fresh setup link and emails it through the outbox, paced, at most once a day.
export default function SetupReminderButton() {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  async function openDialog() {
    setOpen(true);
    setSummary(null);
    setResult(null);
    setError("");
    try {
      setSummary(await apiFetch("/api/admin/setup-reminders"));
    } catch (err) {
      setError(err.message);
    }
  }

  async function send() {
    setSending(true);
    try {
      const done = await apiFetch("/api/admin/setup-reminders", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setResult(done);
      notifySuccess(
        `${number(done.queued)} reminder${done.queued === 1 ? "" : "s"} queued`,
      );
    } catch (err) {
      notifyError(err, { title: "Couldn't send the reminders" });
    } finally {
      setSending(false);
    }
  }

  const remaining = summary?.remainingToday;
  const willSend =
    summary && remaining !== null && remaining !== undefined
      ? Math.min(summary.eligible, remaining)
      : summary?.eligible;

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={openDialog}>
        <KeyRound aria-hidden="true" />
        Remind account setup
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remind accepted people to set up their account
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2" aria-live="polite">
                {error
                  ? <p className="text-destructive">{error}</p>
                  : !summary
                    ? <Skeleton className="h-12 w-full" />
                    : result
                      ? <p>
                          {number(result.queued)} queued.{" "}
                          {number(result.skippedRecent)} skipped because they
                          got a setup email in the last 24 hours
                          {result.deferredByLimit
                            ? `, ${number(result.deferredByLimit)} left for later because of the daily sending limit`
                            : ""}
                          . Watch them go out in the Email outbox.
                        </p>
                      : <>
                          <p>
                            {number(summary.needSetup)} accepted{" "}
                            {summary.needSetup === 1
                              ? "person has"
                              : "people have"}{" "}
                            no password and no Google sign-in yet.{" "}
                            {number(summary.eligible)} can be reminded now;{" "}
                            {number(summary.skippedRecent)} got a setup email in
                            the last 24 hours.
                          </p>
                          <p>
                            Each gets a new setup link (valid 7 days) that
                            replaces the earlier one. Emails go out one at a
                            time.
                          </p>
                          {willSend < summary.eligible
                            ? <p className="text-warning">
                                The daily sending limit leaves room for{" "}
                                {number(willSend)} today. Run this again
                                tomorrow for the rest.
                              </p>
                            : null}
                          {summary.emailConfigured === false
                            ? <p className="text-warning">
                                Email isn&apos;t set up on the server, so
                                nothing can be sent.
                              </p>
                            : null}
                        </>}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sending}>
              {result ? "Close" : "Cancel"}
            </AlertDialogCancel>
            {result
              ? null
              : <Button
                  type="button"
                  loading={sending}
                  disabled={
                    !summary || !willSend || summary.emailConfigured === false
                  }
                  onClick={send}
                >
                  {summary && willSend
                    ? `Send ${number(willSend)} reminder${willSend === 1 ? "" : "s"}`
                    : "Send reminders"}
                </Button>}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
