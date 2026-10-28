"use client";

import { useCallback, useEffect, useState } from "react";
import QRScanner from "@/components/QRScanner";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

export default function StaffTeamManager({ attendeeId }) {
  const user = useUser();
  const [confirmation, setConfirmation] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [lookupEmail, setLookupEmail] = useState("");
  const lookup = useCallback(async (body) => {
    setBusy(true);
    setError("");
    setAdding(false);
    try {
      setData(
        await apiFetch("/api/staff/teams/lookup", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (err) {
      setData(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (attendeeId) lookup({ userId: attendeeId });
  }, [attendeeId, lookup]);
  async function change(path, method, body) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await apiFetch(`/api/staff/teams/${data.team._id}${path}`, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      setData((previous) => ({ ...previous, team: next.team }));
      notifySuccess("Team updated");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4" aria-live="polite">
      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.label}</AlertDialogTitle>
            <AlertDialogDescription>
              The team and its judging project will be updated. Hardware loans
              may need returning.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep team unchanged</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const path = confirmation.path;
                setConfirmation(null);
                change(path, "DELETE");
              }}
            >
              Confirm change
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <h2 className="text-base font-semibold">Team help</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          lookup({ email: lookupEmail });
        }}
        className="space-y-2"
      >
        <Label htmlFor="team-lookup-email">Find attendee by email</Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="team-lookup-email"
            type="email"
            required
            value={lookupEmail}
            onChange={(event) => setLookupEmail(event.target.value)}
          />
          <Button type="submit" loading={busy}>
            Find team
          </Button>
        </div>
      </form>
      <p className="text-sm text-muted-foreground">
        {adding
          ? "Scan the attendee to add to this team."
          : "Scan an attendee to find their team."}
      </p>
      <QRScanner
        onScan={(qrId) =>
          adding ? change("/members", "POST", { qrId }) : lookup({ qrId })
        }
      />
      {busy && (
        <output className="text-sm text-muted-foreground">
          Updating team details
        </output>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {data && !data.team && (
        <p className="text-sm text-muted-foreground">
          {data.attendee.name} is on no team.
        </p>
      )}
      {data?.team && (
        <Card>
          <CardHeader>
            <CardTitle>{data.team.name}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {data.team.lockedAt
                ? "Checked in for judging: team locked"
                : "Team unlocked"}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              {data.team.project
                ? `${data.team.project.name}. ${data.team.project.tableNumber ? `Table ${data.team.project.tableNumber}, ${data.team.project.room?.name}` : "No table assigned"}`
                : "No judging project"}
            </p>
            <fieldset disabled={busy} className="space-y-4">
              <ul className="divide-y">
                {data.team.members.map((member) => (
                  <li
                    key={member._id}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span>
                      {member.name} ({member.email})
                    </span>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setConfirmation({
                          path: `/members/${member._id}`,
                          label: `Remove ${member.name} from this team?`,
                        })
                      }
                    >
                      Remove member
                    </Button>
                  </li>
                ))}
              </ul>
              <ul className="divide-y">
                {data.team.invites.map((invite) => (
                  <li
                    key={invite.email}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span>{invite.email}</span>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setConfirmation({
                          path: `/invites/${encodeURIComponent(invite.email)}`,
                          label: `Cancel the invite for ${invite.email}?`,
                        })
                      }
                    >
                      Cancel invite
                    </Button>
                  </li>
                ))}
              </ul>
              {!data.team.invites.length && (
                <p className="text-sm text-muted-foreground">
                  No pending invites.
                </p>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  change("/invites", "POST", { email });
                }}
                className="space-y-2"
              >
                <Label htmlFor="staff-team-email">Invite by email</Label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="staff-team-email"
                    required
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  <Button type="submit">Send invite</Button>
                </div>
              </form>
              <Button variant="outline" onClick={() => setAdding(!adding)}>
                {adding ? "Find team by scan" : "Add attendee by scan"}
              </Button>
              {user.role === "admin" && data.team.lockedAt && (
                <Button
                  variant="outline"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await apiFetch(
                        `/api/admin/teams/${data.team._id}/unlock`,
                        { method: "POST" },
                      );
                      await lookup({ userId: data.attendee.id });
                      notifySuccess("Team unlocked");
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Unlock team
                </Button>
              )}
            </fieldset>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
