"use client";

import { KeyRound, QrCode, Search, UserCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatTime } from "@/components/CheckInStation";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

const STATUS_WORDS = {
  none: "Has not applied",
  draft: "Draft",
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  waitlisted: "Waitlisted",
};

// Attendee help (moderators + admins): look someone up by email, then resend
// their QR code email, send them an account setup / password reset link, or
// force-check them in.
export default function AttendeeHelpPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";

  const [email, setEmail] = useState("");
  const [attendee, setAttendee] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
  }, [isStaff, router]);

  if (!isStaff) return null;

  async function run(action, fn) {
    setError("");
    setBusy(action);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
      if (err.data?.attendee)
        setAttendee((a) => ({ ...a, ...err.data.attendee }));
    } finally {
      setBusy("");
    }
  }

  function lookUp(e) {
    e.preventDefault();
    run("lookup", async () => {
      setAttendee(null);
      const data = await apiFetch(
        `/api/staff/attendee?email=${encodeURIComponent(email.trim())}`,
      );
      setAttendee(data.attendee);
      setReason("");
    });
  }

  function resendQr() {
    run("qr", async () => {
      await apiFetch("/api/staff/attendee/resend-qr", {
        method: "POST",
        body: JSON.stringify({ email: attendee.email }),
      });
      notifySuccess(`QR code email sent to ${attendee.email}.`);
    });
  }

  function sendAccountLink() {
    run("link", async () => {
      const data = await apiFetch("/api/staff/attendee/send-account-link", {
        method: "POST",
        body: JSON.stringify({ email: attendee.email }),
      });
      setAttendee(data.attendee);
      notifySuccess(
        data.kind === "setup"
          ? `Account setup link sent to ${attendee.email}. It works for 7 days.`
          : `Password reset link sent to ${attendee.email}. It works for 1 hour.`,
      );
    });
  }

  function forceCheckIn(e) {
    e.preventDefault();
    run("checkin", async () => {
      const data = await apiFetch("/api/staff/checkin", {
        method: "POST",
        body: JSON.stringify({
          userId: attendee.id,
          force: true,
          reason: reason.trim(),
        }),
      });
      setAttendee((a) => ({
        ...a,
        checkedIn: true,
        checkedInAt: data.checkIn?.checkedInAt || new Date().toISOString(),
      }));
      notifySuccess(
        data.forced
          ? `${attendee.name} is checked in (forced).`
          : `${attendee.name} is checked in.`,
      );
    });
  }

  const accepted = attendee?.applicationStatus === "accepted";
  const statusWord = attendee
    ? STATUS_WORDS[attendee.applicationStatus] || attendee.applicationStatus
    : "";

  return (
    <div className="mx-auto w-full max-w-2xl">
      <PageHeader
        title="Attendee help"
        description="Find someone by email to resend their QR code, send a way into their account, or check them in by hand."
      />

      <div className="space-y-4">
        <form onSubmit={lookUp} className="flex flex-wrap gap-2">
          <Input
            type="email"
            required
            aria-label="Attendee email"
            placeholder="attendee@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="min-w-48 flex-1"
          />
          <Button
            type="submit"
            loading={busy === "lookup"}
            disabled={!email.trim()}
          >
            <Search aria-hidden="true" />
            {busy === "lookup" ? "Looking up" : "Look up"}
          </Button>
        </form>

        {error
          ? <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : null}

        {attendee
          ? <Card>
              <CardHeader>
                <CardTitle className="text-lg">{attendee.name}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {attendee.email}
                </p>
              </CardHeader>
              <CardContent className="space-y-5">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Application</dt>
                  <dd className="font-medium">{statusWord}</dd>
                  <dt className="text-muted-foreground">Checked in</dt>
                  <dd className="tabular-nums">
                    {attendee.checkedIn
                      ? `Yes, at ${formatTime(attendee.checkedInAt)}`
                      : "Not yet"}
                  </dd>
                  <dt className="text-muted-foreground">Account</dt>
                  <dd>
                    {attendee.accountReady
                      ? "Can sign in"
                      : "No password yet (applied without an account)"}
                  </dd>
                </dl>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!accepted}
                    loading={busy === "qr"}
                    title={
                      accepted
                        ? undefined
                        : "Only accepted applicants have a QR code"
                    }
                    onClick={resendQr}
                  >
                    <QrCode aria-hidden="true" />
                    {busy === "qr" ? "Sending" : "Resend QR code email"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    loading={busy === "link"}
                    onClick={sendAccountLink}
                  >
                    <KeyRound aria-hidden="true" />
                    {busy === "link"
                      ? "Sending"
                      : attendee.accountReady
                        ? "Send password reset link"
                        : "Send account setup link"}
                  </Button>
                </div>

                {attendee.checkedIn
                  ? null
                  : <>
                      <Separator />
                      <form onSubmit={forceCheckIn} className="space-y-1.5">
                        <Label htmlFor="force-reason" className="leading-snug">
                          {accepted
                            ? "Check in by hand. Note why, for example a lost QR code."
                            : `Their application is ${attendee.applicationStatus === "none" ? "missing" : statusWord.toLowerCase()}. Note why you are checking them in.`}
                        </Label>
                        <div className="flex flex-wrap gap-2">
                          <Input
                            id="force-reason"
                            required
                            minLength={3}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="Reason (at least 3 characters)"
                            className="min-w-48 flex-1"
                          />
                          <Button
                            type="submit"
                            loading={busy === "checkin"}
                            disabled={reason.trim().length < 3}
                          >
                            <UserCheck aria-hidden="true" />
                            {busy === "checkin" ? "Checking in" : "Check in"}
                          </Button>
                        </div>
                      </form>
                    </>}
              </CardContent>
            </Card>
          : null}
      </div>
    </div>
  );
}
