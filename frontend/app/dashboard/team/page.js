"use client";

import {
  Crown,
  Link2,
  LogOut,
  Mail,
  Pencil,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { useEffect, useState } from "react";
import JudgingTableCard from "@/components/JudgingTableCard";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/skeletons";
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
import { Badge } from "@/components/ui/badge";
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
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api";
import { loadSiteMeta } from "@/lib/features";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

// The caller's hackathon team: start one, answer invites, invite teammates by
// email, and save the team's Devpost project link (which judging uses to
// match the project to the team).
export default function TeamPage() {
  const user = useUser();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    apiFetch("/api/teams/me")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  // Runs one team request. `label` names it for the pending state; `done` is
  // the toast on success. Resolves true when it worked.
  async function act(label, path, options, done) {
    setError("");
    setBusy(label);
    try {
      const next = await apiFetch(path, options);
      setData(next);
      if (done) notifySuccess(done);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy("");
    }
  }

  const team = data?.team;
  const isLeader = team && String(team.leader?._id) === String(user._id);

  return (
    <div className="mx-auto w-full max-w-2xl">
      <JudgingTableCard />
      <PageHeader
        title="Team"
        description={`Teams of up to ${data?.maxSize || 4}. Add your Devpost link after you submit so judges can find your project.`}
      />

      <div className="space-y-4">
        {error
          ? <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : null}

        {!data && !error ? <CardSkeleton lines={4} /> : null}

        {data?.invites?.length
          ? <Invites
              invites={data.invites}
              busy={busy}
              act={act}
              onTeam={Boolean(team)}
            />
          : null}

        {team
          ? <TeamCard
              team={team}
              isLeader={isLeader}
              userId={user._id}
              busy={busy}
              act={act}
            />
          : data
            ? <CreateTeam busy={busy} act={act} />
            : null}
      </div>
    </div>
  );
}

function Invites({ invites, busy, act, onTeam }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Invites for you</CardTitle>
        {onTeam
          ? <CardDescription>
              Leave your current team to accept one.
            </CardDescription>
          : null}
      </CardHeader>
      <CardContent className="divide-y">
        {invites.map((inv) => (
          <div
            key={inv.teamId}
            className="flex flex-wrap items-center gap-2 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-48 flex-1">
              <p className="text-sm font-medium">{inv.teamName}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {inv.members} member{inv.members === 1 ? "" : "s"}
                {inv.invitedBy ? `, invited by ${inv.invitedBy}` : ""}
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={onTeam}
              loading={busy === `accept-${inv.teamId}`}
              onClick={() =>
                act(
                  `accept-${inv.teamId}`,
                  `/api/teams/invites/${inv.teamId}/accept`,
                  { method: "POST" },
                  `You joined ${inv.teamName}.`,
                )
              }
            >
              Accept
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={busy === `decline-${inv.teamId}`}
              onClick={() =>
                act(
                  `decline-${inv.teamId}`,
                  `/api/teams/invites/${inv.teamId}/decline`,
                  { method: "POST" },
                )
              }
            >
              Decline
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function CreateTeam({ busy, act }) {
  const [name, setName] = useState("");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a team</CardTitle>
        <CardDescription>
          Or ask a teammate to invite your email, then accept it here.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act(
              "create",
              "/api/teams",
              { method: "POST", body: JSON.stringify({ name }) },
              "Team created. Invite your teammates below.",
            );
          }}
        >
          <Input
            aria-label="Team name"
            required
            placeholder="Team name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            className="min-w-48 flex-1"
          />
          <Button
            type="submit"
            loading={busy === "create"}
            disabled={name.trim().length < 2}
          >
            {busy === "create" ? "Creating" : "Create team"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// A confirm step for destructive team actions.
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  onConfirm,
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TeamCard({ team, isLeader, userId, busy, act }) {
  const [hasHardware, setHasHardware] = useState(false);
  const [checkingHardware, setCheckingHardware] = useState(false);
  const [hardwareError, setHardwareError] = useState("");

  async function confirmLeave() {
    setCheckingHardware(true);
    setHardwareError("");
    try {
      const meta = await loadSiteMeta();
      let open = false;
      if (meta.features?.hardware !== false) {
        try {
          const mine = await apiFetch("/api/hardware/mine");
          open = mine.checkouts.some((loan) => !loan.returnedAt);
        } catch (err) {
          // Team membership is available to applicants without an acceptance.
          if (err.status !== 400 && err.status !== 404) throw err;
        }
      }
      setHasHardware(open);
      setConfirming({ leave: true });
    } catch (err) {
      setHardwareError(err.message);
    } finally {
      setCheckingHardware(false);
    }
  }

  const [inviteEmail, setInviteEmail] = useState("");
  const [devpost, setDevpost] = useState(team.devpostUrl || "");
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  // Which confirmation is open: "leave" or a member to remove.
  const [confirming, setConfirming] = useState(null);
  const seats = team.maxSize - team.members.length - team.invites.length;

  // Show the saved (normalized) link after a save.
  useEffect(() => {
    setDevpost(team.devpostUrl || "");
  }, [team.devpostUrl]);

  const lastMember = team.members.length === 1;

  return (
    <Card>
      <CardHeader>
        {renaming
          ? <form
              className="flex flex-wrap gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    "rename",
                    "/api/teams/me",
                    { method: "PATCH", body: JSON.stringify({ name }) },
                    "Team renamed.",
                  )
                ) {
                  setRenaming(false);
                }
              }}
            >
              <Input
                aria-label="New team name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                className="min-w-48 flex-1"
              />
              <Button type="submit" loading={busy === "rename"}>
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenaming(false)}
              >
                Cancel
              </Button>
            </form>
          : <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-lg">{team.name}</CardTitle>
              {isLeader
                ? <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setName(team.name);
                      setRenaming(true);
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    Rename
                  </Button>
                : null}
            </div>}
      </CardHeader>

      <CardContent className="space-y-6">
        <section className="space-y-2">
          <h2 className="text-sm font-medium">Members</h2>
          <ul className="divide-y rounded-lg border">
            {team.members.map((m) => {
              const leader = String(m._id) === String(team.leader?._id);
              return (
                <li
                  key={m._id}
                  className="flex min-h-11 items-center gap-2 px-3 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{m.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.email}
                    </p>
                  </div>
                  {leader
                    ? <Badge variant="secondary">
                        <Crown aria-hidden="true" />
                        Leader
                      </Badge>
                    : null}
                  {isLeader && String(m._id) !== String(userId)
                    ? <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${m.name}`}
                        loading={busy === `remove-${m._id}`}
                        onClick={() => setConfirming({ remove: m })}
                      >
                        <UserMinus aria-hidden="true" />
                      </Button>
                    : null}
                </li>
              );
            })}
          </ul>
        </section>

        {team.invites.length
          ? <section className="space-y-2">
              <h2 className="text-sm font-medium">Waiting to accept</h2>
              <ul className="divide-y rounded-lg border">
                {team.invites.map((inv) => (
                  <li
                    key={inv.email}
                    className="flex min-h-11 items-center gap-2 px-3 py-1.5"
                  >
                    <Mail
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {inv.email}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={busy === `cancel-${inv.email}`}
                      onClick={() =>
                        act(
                          `cancel-${inv.email}`,
                          `/api/teams/me/invites/${encodeURIComponent(inv.email)}`,
                          { method: "DELETE" },
                        )
                      }
                    >
                      Cancel invite
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          : null}

        <form
          className="space-y-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await act(
                "invite",
                "/api/teams/me/invites",
                {
                  method: "POST",
                  body: JSON.stringify({ email: inviteEmail }),
                },
                `Invite sent to ${inviteEmail.trim()}.`,
              )
            ) {
              setInviteEmail("");
            }
          }}
        >
          <Label htmlFor="invite-email">Invite a teammate</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="invite-email"
              required
              type="email"
              placeholder="teammate@example.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              disabled={seats <= 0}
              className="min-w-48 flex-1"
            />
            <Button
              type="submit"
              variant="outline"
              loading={busy === "invite"}
              disabled={seats <= 0 || !inviteEmail.trim()}
            >
              <UserPlus aria-hidden="true" />
              {seats <= 0 ? "Team is full" : "Send invite"}
            </Button>
          </div>
        </form>

        <Separator />

        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            act(
              "devpost",
              "/api/teams/me",
              {
                method: "PATCH",
                body: JSON.stringify({ devpostUrl: devpost }),
              },
              devpost.trim() ? "Devpost link saved." : "Devpost link removed.",
            );
          }}
        >
          <Label htmlFor="devpost-url">Devpost project link</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="devpost-url"
              placeholder="https://devpost.com/software/your-project"
              value={devpost}
              onChange={(e) => setDevpost(e.target.value)}
              className="min-w-48 flex-1"
            />
            <Button
              type="submit"
              variant="outline"
              loading={busy === "devpost"}
              disabled={devpost.trim() === (team.devpostUrl || "")}
            >
              <Link2 aria-hidden="true" />
              Save link
            </Button>
          </div>
          {team.devpostUrl
            ? <p className="text-xs text-muted-foreground wrap-anywhere">
                Saved:{" "}
                <a
                  className="font-medium text-link hover:underline"
                  href={team.devpostUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {team.devpostUrl}
                </a>
              </p>
            : null}
        </form>

        <Separator />

        <Button
          type="button"
          variant="destructive"
          loading={busy === "leave" || checkingHardware}
          onClick={confirmLeave}
        >
          <LogOut aria-hidden="true" />
          Leave team
        </Button>
        {hardwareError && (
          <Alert variant="destructive">
            <AlertDescription>{hardwareError}</AlertDescription>
          </Alert>
        )}
      </CardContent>

      <ConfirmDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={
          confirming?.remove
            ? `Remove ${confirming.remove.name}?`
            : lastMember
              ? "Leave and delete this team?"
              : "Leave this team?"
        }
        description={
          confirming?.remove
            ? "They will lose access to the team. You can invite them again later."
            : hasHardware
              ? `${lastMember ? "You are the last member, so leaving deletes the team. " : ""}You have hardware checked out. You will need to return it to the hardware desk after leaving. A member of the team using it can check it out again.`
              : lastMember
                ? "You are the last member, so leaving deletes the team."
                : "You can join another team or be invited back."
        }
        action={confirming?.remove ? "Remove" : "Leave team"}
        onConfirm={() => {
          if (confirming?.remove) {
            act(
              `remove-${confirming.remove._id}`,
              `/api/teams/me/members/${confirming.remove._id}`,
              { method: "DELETE" },
            );
          } else {
            act(
              "leave",
              "/api/teams/me/leave",
              { method: "POST" },
              "You left the team.",
            );
          }
        }}
      />
    </Card>
  );
}
