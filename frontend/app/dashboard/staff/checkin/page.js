"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import CheckInStation, {
  formatTime,
  RecentScans,
  resultFromError,
  useStationLog,
} from "@/components/CheckInStation";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Moderators + admins: first check-in, when attendees arrive. Scanning an
// attendee's QR (camera on a phone/tablet, or a USB scanner into the code box)
// marks them checked in and emails them the Discord link, the website and the
// run of show (as a calendar invite). "Force check-in" covers people whose
// application isn't accepted. Meals have their own screen at
// /dashboard/staff/meals.

const STATUS_LABELS = {
  accepted: "Accepted",
  pending: "Pending review",
  waitlisted: "Waitlisted",
  rejected: "Rejected",
  draft: "Draft (not submitted)",
  none: "No application",
};
export default function StaffCheckInPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";
  const log = useStationLog();
  const [stats, setStats] = useState(null);
  // Forced check-in panel: closed (null), open with no one picked ({}), or
  // open for a specific person ({ attendee }).
  const [force, setForce] = useState(null);

  const loadStats = useCallback(() => {
    apiFetch("/api/staff/checkin/stats")
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
  }, [isStaff, router]);

  useEffect(() => {
    if (isStaff) loadStats();
  }, [isStaff, loadStats]);

  if (!isStaff) return null;

  /**
   * @param {object} who - { qrId } from a scan, or { userId } from the search.
   * @returns {Promise<boolean>} Whether a new check-in was recorded.
   */
  async function checkIn(who) {
    try {
      const data = await apiFetch("/api/staff/checkin", {
        method: "POST",
        body: JSON.stringify(who),
      });
      log.record({
        kind: "success",
        attendee: data.attendee,
        message: data.forced ? "Checked in (forced)" : "Checked in",
        warning: "Email with the Discord link, website and schedule sent.",
        popup: data.popup,
      });
      loadStats();
      return true;
    } catch (err) {
      const result = resultFromError(err);
      // Not accepted: offer a forced check-in for exactly this person.
      if (err.data?.code === "not_accepted" && err.data.attendee) {
        result.action = {
          label: "Force check-in instead",
          onClick: () => setForce({ attendee: err.data.attendee }),
        };
      }
      log.record(result);
      return false;
    }
  }

  async function forceCheckIn(attendee, reason) {
    const ok = await checkIn({ userId: attendee.id, force: true, reason });
    if (ok) setForce(null);
    return ok;
  }


  const percent =
    stats?.accepted > 0
      ? Math.round((stats.checkedIn / stats.accepted) * 100)
      : 0;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader
        className="mb-2"
        title="Check-in"
        description="Scan attendees' QR codes as they arrive."
        actions={
          <Button
            type="button"
            variant="outline"
            onClick={() => setForce(force ? null : {})}
          >
            {force ? "Close forced check-in" : "Force check-in"}
          </Button>
        }
      />

      {force
        ? <ForceCheckInPanel
            initial={force.attendee || null}
            onSubmit={forceCheckIn}
            onClose={() => setForce(null)}
          />
        : null}

      {stats
        ? <Card>
            <CardContent className="space-y-3">
              <p className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
                <span className="text-3xl font-semibold tracking-tight">
                  {stats.checkedIn}
                </span>
                <span className="text-sm text-muted-foreground">
                  of {stats.accepted} checked in
                  {stats.forced ? `, ${stats.forced} forced` : ""}
                </span>
              </p>
              <div
                role="progressbar"
                aria-label="Checked in"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                {/* The width is the one computed value on this screen. */}
                <div
                  className="h-full rounded-full bg-brand transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </CardContent>
          </Card>
        : null}

      <CheckInStation
        title="Scan"
        onCode={(code) => checkIn({ qrId: code })}
        result={log.result}
      />

      <AttendeeSearch onCheckIn={checkIn} />

      <RecentScans recent={log.recent} />
    </div>
  );
}

// Forced check-in: check in someone whose application isn't accepted (or who
// never applied), e.g. an approved walk-in. Pick the person (pre-filled after a
// refused scan, or searched across everyone), give a reason, confirm.
function ForceCheckInPanel({ initial, onSubmit, onClose }) {
  const [target, setTarget] = useState(initial);
  const [reason, setReason] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTarget(initial);
  }, [initial]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setPeople([]);
      return;
    }
    const handle = setTimeout(() => {
      apiFetch(`/api/staff/attendees?all=1&q=${encodeURIComponent(q)}`)
        .then((data) => setPeople(data.attendees || []))
        .catch((err) => setError(err.message));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!target || reason.trim().length < 3) return;
    setSubmitting(true);
    setError("");
    const ok = await onSubmit(target, reason.trim());
    setSubmitting(false);
    if (!ok) setError("The check-in did not go through. See the result below.");
  }

  return (
    <Card className="ring-warning/40">
      <CardHeader>
        <CardTitle>Force check-in</CardTitle>
        <CardDescription>
          Checks in someone whose application is not accepted. Your name and
          the reason are recorded with the check-in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error
            ? <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            : null}

          {target
            ? <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{target.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {target.email},{" "}
                    {STATUS_LABELS[target.applicationStatus] ||
                      target.applicationStatus}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setTarget(null)}
                >
                  Change
                </Button>
              </div>
            : <div className="space-y-1">
                <Input
                  aria-label="Search everyone by name or email"
                  placeholder="Search everyone by name or email"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {people.length > 0
                  ? <ul className="divide-y rounded-lg border">
                      {people.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => setTarget(p)}
                            disabled={p.checkedIn}
                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm outline-none first:rounded-t-lg last:rounded-b-lg hover:bg-muted focus-visible:bg-muted disabled:opacity-60"
                          >
                            <span className="min-w-0 truncate">
                              <span className="font-medium">{p.name}</span>
                              <span className="text-muted-foreground">
                                {" "}
                                {p.email}
                              </span>
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {p.checkedIn
                                ? "Already checked in"
                                : STATUS_LABELS[p.applicationStatus] ||
                                  p.applicationStatus}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  : null}
              </div>}

          <div className="space-y-1.5">
            <Label htmlFor="force-reason">Reason (required)</Label>
            <Textarea
              id="force-reason"
              rows={2}
              placeholder="e.g. Walk-in approved by the lead organizer"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              loading={submitting}
              disabled={!target || reason.trim().length < 3}
            >
              {submitting
                ? "Checking in"
                : target
                  ? `Force check-in ${target.name}`
                  : "Pick someone first"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// Fallback for attendees without their QR code: find them by name or email.
function AttendeeSearch({ onCheckIn }) {
  const [query, setQuery] = useState("");
  const [attendees, setAttendees] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingId, setPendingId] = useState(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setAttendees([]);
      return;
    }
    setLoading(true);
    const handle = setTimeout(() => {
      apiFetch(`/api/staff/attendees?q=${encodeURIComponent(q)}`)
        .then((data) => {
          setAttendees(data.attendees || []);
          setError("");
        })
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  async function handleCheckIn(attendee) {
    setPendingId(attendee.id);
    const ok = await onCheckIn({ userId: attendee.id });
    if (ok) {
      setAttendees((list) =>
        list.map((a) =>
          a.id === attendee.id
            ? { ...a, checkedIn: true, checkedInAt: new Date().toISOString() }
            : a,
        ),
      );
    }
    setPendingId(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>No QR code</CardTitle>
        <CardDescription>
          Search accepted attendees by name or email. Check their ID first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Input
          aria-label="Search attendees by name or email"
          placeholder="Search by name or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-10"
        />

        {error
          ? <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : null}

        {loading && attendees.length === 0
          ? <p className="text-sm text-muted-foreground">Searching</p>
          : query.trim() && attendees.length === 0
            ? <p className="text-sm text-muted-foreground">
                No accepted attendees match.
              </p>
            : attendees.length > 0
              ? <ul className="divide-y rounded-lg border">
                  {attendees.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{a.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {a.email}
                        </p>
                      </div>
                      {a.checkedIn
                        ? <p className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                            <Check className="size-3.5" aria-hidden="true" />
                            Checked in {formatTime(a.checkedInAt)}
                            {a.checkedInBy ? ` by ${a.checkedInBy}` : ""}
                          </p>
                        : <Button
                            type="button"
                            loading={pendingId === a.id}
                            onClick={() => handleCheckIn(a)}
                          >
                            {pendingId === a.id ? "Checking in" : "Check in"}
                          </Button>}
                    </li>
                  ))}
                </ul>
              : null}
      </CardContent>
    </Card>
  );
}
