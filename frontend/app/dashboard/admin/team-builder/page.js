"use client";

import {
  CircleCheck,
  Download,
  Network,
  RefreshCw,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import SearchInput from "@/components/SearchInput";
import { downloadFile, number } from "@/components/StatsParts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

// Admin team builder: proposes teams from what applicants wrote in the
// "list your teammates" question, creates them (people with accounts are
// added, the rest get the usual team invite), and lists the accepted people
// left on no team, split by their research-study answer.

const SCOPE = [
  ["accepted", "Accepted"],
  ["pending", "Pending"],
  ["waitlisted", "Waitlisted"],
];

const SHOW = [
  ["todo", "Not done yet"],
  ["flagged", "Needs a look"],
  ["clean", "No flags"],
  ["done", "Done"],
  ["all", "All"],
];

const NEW_TEAM = "new";
const NO_ANSWER = "__none__";

function plural(count, one, many) {
  return `${number(count)} ${count === 1 ? one : many || `${one}s`}`;
}

function flagCount(p) {
  const f = p.flags;
  return (
    (f.overMax ? 1 : 0) +
    (f.differentTeams ? 1 : 0) +
    (f.lockedTeam ? 1 : 0) +
    (f.noApplication.length ? 1 : 0) +
    (f.notInScope.length ? 1 : 0) +
    (f.unmatchedNames.length ? 1 : 0) +
    (p.links.oneSided ? 1 : 0)
  );
}

// The default choices for a proposal: everyone in, the suggested leader,
// merge when one member's team is the obvious home.
function defaultEdit(p) {
  return {
    name: p.defaultName,
    leaderEmail: p.leaderEmail,
    target: p.suggestedMergeTeamId || NEW_TEAM,
    excluded: [],
  };
}

function requestFor(p, edit) {
  const memberEmails = p.members
    .map((m) => m.email)
    .filter((email) => !edit.excluded.includes(email));
  return edit.target === NEW_TEAM
    ? {
        memberEmails,
        name: edit.name.trim(),
        leaderEmail: edit.leaderEmail,
      }
    : { memberEmails, mergeIntoTeamId: edit.target };
}

export default function TeamBuilderPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const [statuses, setStatuses] = useState(["accepted"]);
  const [round, setRound] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [edits, setEdits] = useState({});
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState("todo");
  const [confirm, setConfirm] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [tab, setTab] = useState("proposals");

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
  }, [isAdmin, router]);

  const scopeQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (round) q.set("round", round);
    q.set("statuses", statuses.join(","));
    return q.toString();
  }, [round, statuses]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await apiFetch(
        `/api/admin/team-builder/proposals?${scopeQuery}`,
      );
      setData(next);
      setEdits({});
      setSelected([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [scopeQuery]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const proposals = data?.proposals || [];
  const editOf = useCallback((p) => edits[p.id] || defaultEdit(p), [edits]);

  function updateEdit(p, patch) {
    setEdits((current) => ({
      ...current,
      [p.id]: { ...(current[p.id] || defaultEdit(p)), ...patch },
    }));
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return proposals.filter((p) => {
      if (show === "todo" && p.done) return false;
      if (show === "done" && !p.done) return false;
      if (show === "flagged" && (p.done || flagCount(p) === 0)) return false;
      if (show === "clean" && (p.done || flagCount(p) > 0)) return false;
      if (!q) return true;
      return p.members.some((m) =>
        `${m.name} ${m.email} ${m.listedAs}`.toLowerCase().includes(q),
      );
    });
  }, [proposals, query, show]);

  const selectable = visible.filter((p) => !p.done);
  const allSelected =
    selectable.length > 0 && selectable.every((p) => selected.includes(p.id));

  function toggleAll(checked) {
    const ids = selectable.map((p) => p.id);
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, ...ids]))
        : current.filter((id) => !ids.includes(id)),
    );
  }

  function toggleOne(id, checked) {
    setSelected((current) =>
      checked ? [...current, id] : current.filter((x) => x !== id),
    );
  }

  // Ask the server what a run would do (exact counts), then confirm.
  async function prepare(ids) {
    const chosen = proposals.filter((p) => ids.includes(p.id));
    if (!chosen.length) return;
    const body = {
      round: data?.round?._id,
      statuses,
      proposals: chosen.map((p) => requestFor(p, editOf(p))),
    };
    setRunning(true);
    try {
      const preview = await apiFetch("/api/admin/team-builder/apply", {
        method: "POST",
        body: JSON.stringify({ ...body, dryRun: true }),
      });
      setConfirm({ body, preview, allowOverLimit: false });
    } catch (err) {
      notifyError(err, { title: "Couldn't check these teams" });
    } finally {
      setRunning(false);
    }
  }

  async function run() {
    if (!confirm) return;
    setRunning(true);
    try {
      const done = await apiFetch("/api/admin/team-builder/apply", {
        method: "POST",
        body: JSON.stringify({
          ...confirm.body,
          allowOverLimit: confirm.allowOverLimit || undefined,
        }),
      });
      setResult(done);
      setConfirm(null);
      notifySuccess(
        `${plural(done.totals.created, "team")} created, ${plural(done.totals.invited, "invite")} sent`,
      );
      await load();
    } catch (err) {
      notifyError(err, { title: "Couldn't create the teams" });
    } finally {
      setRunning(false);
    }
  }

  if (!isAdmin) return null;

  const counts = data?.counts;
  const description = counts
    ? [
        data.round ? `From ${data.round.name}.` : null,
        counts.saidHasTeam !== null
          ? `${number(counts.saidHasTeam)} of ${number(counts.inScope)} said they have a team, ${number(counts.listedSomeone)} listed an email.`
          : `${number(counts.listedSomeone)} of ${number(counts.inScope)} listed a teammate's email.`,
        `${plural(counts.proposals, "proposed team")}, ${number(counts.done)} done.`,
      ]
        .filter(Boolean)
        .join(" ")
    : null;

  return (
    <div>
      <PageHeader
        title="Team builder"
        description={description}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={load}
          >
            <RefreshCw
              className={cn(loading && "animate-spin")}
              aria-hidden="true"
            />
            Refresh
          </Button>
        }
      />

      <ScopeBar
        data={data}
        round={round}
        onRound={setRound}
        statuses={statuses}
        onStatuses={setStatuses}
      />

      {error
        ? <Alert variant="destructive" className="mb-4">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error}
              <Button type="button" variant="outline" size="sm" onClick={load}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        : null}

      {data && !data.questions?.teammates && data.round
        ? <Alert className="mb-4">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>No teammates question found</AlertTitle>
            <AlertDescription>
              Proposals come from a text question that asks for teammates (key
              &quot;teammates&quot;, or a label that mentions teammates). This
              round&apos;s form has none.
            </AlertDescription>
          </Alert>
        : null}

      {result
        ? <RunSummary result={result} onClose={() => setResult(null)} />
        : null}

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="proposals">
            Proposed teams
            {data ? <Count value={visibleTodo(proposals)} /> : null}
          </TabsTrigger>
          <TabsTrigger value="unmatched">
            Couldn&apos;t match
            {data ? <Count value={data.unmatched.length} /> : null}
          </TabsTrigger>
          <TabsTrigger value="unteamed">Not on a team</TabsTrigger>
        </TabsList>

        <TabsContent value="proposals">
          <DataTable
            columns={proposalColumns({
              selected,
              toggleOne,
              allSelected,
              toggleAll,
              anySelectable: selectable.length > 0,
              editOf,
              updateEdit,
              maxSize: data?.maxSize,
              onCreate: (p) => prepare([p.id]),
              running,
            })}
            data={visible}
            loading={!data && !error}
            getRowId={(p) => p.id}
            dense
            toolbar={
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput
                  label="Search proposed teams"
                  placeholder="Search name or email"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="sm:w-64"
                />
                <Select value={show} onValueChange={setShow}>
                  <SelectTrigger
                    size="sm"
                    className="w-40"
                    aria-label="Show proposals"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHOW.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {number(selected.length)} selected
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!selected.length || running}
                    loading={running && !confirm}
                    onClick={() => prepare(selected)}
                  >
                    Create teams and send invites
                  </Button>
                </div>
              </div>
            }
            emptyState={
              <EmptyState
                icon={Network}
                title={
                  proposals.length
                    ? "No proposed teams match."
                    : "No proposed teams."
                }
                description={
                  proposals.length
                    ? "Change the search or what is shown."
                    : "Teams are proposed when applicants list a teammate's email. Widen the statuses to include more applicants."
                }
              />
            }
          />
        </TabsContent>

        <TabsContent value="unmatched">
          <Unmatched rows={data?.unmatched} loading={!data && !error} />
        </TabsContent>

        <TabsContent value="unteamed">
          {tab === "unteamed"
            ? <Unteamed round={data?.round?._id || round} />
            : null}
        </TabsContent>
      </Tabs>

      <ConfirmRun
        confirm={confirm}
        setConfirm={setConfirm}
        running={running}
        onRun={run}
      />
    </div>
  );
}

function visibleTodo(proposals) {
  return proposals.filter((p) => !p.done).length;
}

function Count({ value }) {
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {number(value)}
    </span>
  );
}

function ScopeBar({ data, round, onRound, statuses, onStatuses }) {
  const rounds = data?.rounds || [];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
      {rounds.length > 1
        ? <Select
            value={round || data?.round?._id || ""}
            onValueChange={onRound}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="Round">
              <SelectValue placeholder="Round" />
            </SelectTrigger>
            <SelectContent>
              {rounds.map((r) => (
                <SelectItem key={r._id} value={r._id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        : null}
      <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <legend className="sr-only">Applicants to build teams from</legend>
        <span className="text-sm text-muted-foreground" aria-hidden="true">
          Applicants:
        </span>
        {SCOPE.map(([value, label]) => {
          const checked = statuses.includes(value);
          return (
            <div key={value} className="flex items-center gap-2">
              <Checkbox
                id={`scope-${value}`}
                checked={checked}
                disabled={checked && statuses.length === 1}
                onCheckedChange={(next) =>
                  onStatuses(
                    next
                      ? [...statuses, value]
                      : statuses.filter((s) => s !== value),
                  )
                }
              />
              <Label htmlFor={`scope-${value}`} className="font-normal">
                {label}
              </Label>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}

function proposalColumns(ctx) {
  return [
    {
      id: "select",
      enableSorting: false,
      meta: { className: "w-8 [&:is(td)]:align-top" },
      header: () => (
        <Checkbox
          aria-label="Select every proposed team shown"
          checked={ctx.allSelected}
          disabled={!ctx.anySelectable}
          onCheckedChange={(v) => ctx.toggleAll(Boolean(v))}
        />
      ),
      cell: ({ row }) => {
        const p = row.original;
        return p.done
          ? <CircleCheck
              className="mt-1 size-4 text-success"
              aria-label="Done"
            />
          : <Checkbox
              className="mt-1"
              aria-label={`Select the team with ${p.members[0]?.name || p.members[0]?.email}`}
              checked={ctx.selected.includes(p.id)}
              onCheckedChange={(v) => ctx.toggleOne(p.id, Boolean(v))}
            />;
      },
    },
    {
      id: "team",
      header: "Team",
      enableSorting: false,
      meta: { className: "md:w-72 [&:is(td)]:align-top" },
      cell: ({ row }) => (
        <TeamCell
          p={row.original}
          edit={ctx.editOf(row.original)}
          update={(patch) => ctx.updateEdit(row.original, patch)}
          onCreate={() => ctx.onCreate(row.original)}
          running={ctx.running}
          maxSize={ctx.maxSize}
        />
      ),
    },
    {
      id: "members",
      header: "Members",
      enableSorting: false,
      meta: { className: "hidden md:table-cell [&:is(td)]:align-top" },
      cell: ({ row }) => (
        <Members
          p={row.original}
          edit={ctx.editOf(row.original)}
          update={(patch) => ctx.updateEdit(row.original, patch)}
          maxSize={ctx.maxSize}
        />
      ),
    },
  ];
}

function TeamCell({ p, edit, update, onCreate, running, maxSize }) {
  const merging = edit.target !== NEW_TEAM;
  const leaders = p.members.filter(
    (m) =>
      m.hasAccount &&
      !m.team &&
      m.status !== "rejected" &&
      !edit.excluded.includes(m.email),
  );
  const openTeams = p.existingTeams.filter((t) => !t.locked);
  const nameId = `name-${p.id}`;
  return (
    <div className="space-y-2 whitespace-normal">
      {p.existingTeams.length
        ? <Select
            value={edit.target}
            onValueChange={(target) => update({ target })}
            disabled={p.done}
          >
            <SelectTrigger
              size="sm"
              className="w-full"
              aria-label="What to do with this team"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NEW_TEAM}>Create a new team</SelectItem>
              {openTeams.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  Merge into {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        : null}
      {merging
        ? <p className="text-xs text-muted-foreground">
            Everyone else gets an invite to{" "}
            {p.existingTeams.find((t) => t.id === edit.target)?.name}.
          </p>
        : <>
            <div className="space-y-1">
              <Label htmlFor={nameId} className="sr-only">
                Team name
              </Label>
              <Input
                id={nameId}
                value={edit.name}
                maxLength={60}
                disabled={p.done}
                onChange={(e) => update({ name: e.target.value })}
                className="h-8"
              />
            </div>
            {leaders.length > 1 && !p.done
              ? <Select
                  value={
                    leaders.some((m) => m.email === edit.leaderEmail)
                      ? edit.leaderEmail
                      : leaders[0].email
                  }
                  onValueChange={(leaderEmail) => update({ leaderEmail })}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full"
                    aria-label="Team leader"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {leaders.map((m) => (
                      <SelectItem key={m.email} value={m.email}>
                        Leader: {m.name || m.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              : null}
          </>}
      <Flags p={p} />
      {/* Narrow screens have no Members column: list them here. */}
      <div className="md:hidden">
        <Members p={p} edit={edit} update={update} maxSize={maxSize} />
      </div>
      {p.done
        ? null
        : <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={running || (!merging && edit.name.trim().length < 2)}
            onClick={onCreate}
          >
            {merging ? "Send invites" : "Create team"}
          </Button>}
    </div>
  );
}

function Flags({ p }) {
  const f = p.flags;
  const items = [];
  if (p.done) items.push(["success", "Done"]);
  if (p.links.mutual && !p.links.oneSided) items.push(["success", "Mutual"]);
  if (p.links.oneSided)
    items.push([
      "warning",
      `One-sided: ${p.links.oneSided} of ${p.links.oneSided + p.links.mutual}`,
    ]);
  if (f.overMax) items.push(["warning", "Over the size limit"]);
  if (f.differentTeams) items.push(["warning", "On different teams"]);
  if (f.lockedTeam) items.push(["warning", "Locked team"]);
  if (f.noApplication.length)
    items.push(["info", `${f.noApplication.length} not applied`]);
  if (f.notInScope.length)
    items.push(["info", `${f.notInScope.length} outside the statuses`]);
  if (p.links.byName) items.push(["info", "Matched by name"]);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {items.map(([variant, label]) => (
        <Badge key={label} variant={variant}>
          {label}
        </Badge>
      ))}
    </div>
  );
}

function Members({ p, edit, update, maxSize }) {
  const included = p.members.filter((m) => !edit.excluded.includes(m.email));
  return (
    <div className="space-y-2 whitespace-normal">
      <ul className="space-y-1.5">
        {p.members.map((m) => {
          const out = edit.excluded.includes(m.email);
          return (
            <li key={m.email} className="flex items-start gap-2">
              <Checkbox
                className="mt-0.5"
                checked={!out}
                disabled={p.done}
                aria-label={`Include ${m.name || m.email}`}
                onCheckedChange={(v) =>
                  update({
                    excluded: v
                      ? edit.excluded.filter((e) => e !== m.email)
                      : [...edit.excluded, m.email],
                  })
                }
              />
              <div className={cn("min-w-0", out && "opacity-50")}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium text-foreground">
                    {m.name || m.listedAs || "No name"}
                  </span>
                  <span className="text-xs break-all text-muted-foreground">
                    {m.email}
                  </span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {m.status
                    ? <ApplicationStatusBadge status={m.status} />
                    : <span>No application</span>}
                  {m.hasAccount ? null : <span>No account yet</span>}
                  {m.team
                    ? <Badge variant="info">
                        On {m.team.name}
                        {m.team.locked ? " (locked)" : ""}
                      </Badge>
                    : null}
                  {m.invitedTo.length
                    ? <Badge variant="outline">
                        Invited to {m.invitedTo[0].name}
                      </Badge>
                    : null}
                  {m.listedBy.length && !m.lists.length && m.status
                    ? <span>Didn&apos;t list anyone back</span>
                    : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {maxSize && included.length > maxSize
        ? <p className="text-xs text-warning">
            {included.length} people, the limit is {maxSize}. The ones after the
            first {maxSize} are skipped.
          </p>
        : null}
      {p.flags.unmatchedNames.map((u) => (
        <p
          key={u.email}
          className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
        >
          {u.name || u.email} also wrote names without emails:{" "}
          <span className="text-foreground">&ldquo;{u.raw}&rdquo;</span>
        </p>
      ))}
    </div>
  );
}

function ConfirmRun({ confirm, setConfirm, running, onRun }) {
  const t = confirm?.preview?.totals;
  return (
    <AlertDialog
      open={Boolean(confirm)}
      onOpenChange={(open) => (open ? null : setConfirm(null))}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t
              ? `Create ${plural(t.created, "team")} and send ${plural(t.invited, "invite")}?`
              : "Create teams?"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              {t
                ? <ul className="list-disc space-y-1 pl-5">
                    <li>
                      {plural(t.added, "person", "people")} with an account
                      added to new teams directly (leaders included).
                    </li>
                    <li>
                      {plural(t.invited, "invite")} emailed, to people without
                      an account or to existing teams (
                      {plural(t.merged, "team")} merged).
                    </li>
                    <li>
                      {plural(t.skipped, "person", "people")} skipped: already
                      on a team, already invited, rejected or over the size
                      limit.
                    </li>
                    {t.skippedTeams
                      ? <li>
                          {plural(t.skippedTeams, "proposed team")} with nothing
                          to do.
                        </li>
                      : null}
                  </ul>
                : null}
              <p>Nobody is moved off a team they are already on.</p>
              {confirm?.preview?.emailConfigured === false
                ? <p className="text-warning">
                    Email isn&apos;t set up, so the invites are recorded but not
                    emailed. People still see them on their Team page.
                  </p>
                : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {confirm?.preview?.overLimit
          ? <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm text-warning">
              <Checkbox
                id="over-limit"
                className="mt-0.5"
                checked={confirm.allowOverLimit}
                onCheckedChange={(v) =>
                  setConfirm({ ...confirm, allowOverLimit: Boolean(v) })
                }
              />
              <Label htmlFor="over-limit" className="font-normal">
                This goes over the daily sending limit (
                {number(confirm.preview.committedLast24h)} of{" "}
                {number(confirm.preview.dailyLimit)} used). Send anyway; the
                extra emails are retried later.
              </Label>
            </div>
          : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={running}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            loading={running}
            disabled={
              !t ||
              (t.created === 0 && t.invited === 0) ||
              (confirm?.preview?.overLimit && !confirm.allowOverLimit)
            }
            onClick={onRun}
          >
            Create teams and send invites
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RunSummary({ result, onClose }) {
  const [open, setOpen] = useState(false);
  const t = result.totals;
  const skipped = [];
  for (const r of result.results) {
    if (r.action === "skipped" && r.reason) {
      skipped.push({
        key: `${r.proposalId}-team`,
        who: r.teamName || "Proposed team",
        reason: r.reason,
      });
    }
    for (const s of r.skipped) {
      skipped.push({
        key: `${r.proposalId}-${s.email}`,
        who: `${s.name || s.email} (${r.teamName || "proposed team"})`,
        reason: s.reason,
      });
    }
  }
  return (
    <Alert className="mb-4" aria-live="polite">
      <CircleCheck aria-hidden="true" />
      <AlertTitle>
        {plural(t.created, "team")} created, {plural(t.merged, "team")} merged
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {plural(t.added, "person", "people")} added,{" "}
          {plural(t.invited, "invite")} sent,{" "}
          {plural(t.skipped + t.skippedTeams, "skip")}.
        </p>
        <div className="flex flex-wrap gap-2">
          {skipped.length
            ? <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
              >
                {open ? "Hide what was skipped" : "Show what was skipped"}
              </Button>
            : null}
          <Button type="button" variant="ghost" size="xs" onClick={onClose}>
            Dismiss
          </Button>
        </div>
        {open
          ? <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
              {skipped.map((s) => (
                <li key={s.key}>
                  <span className="text-foreground">{s.who}</span>: {s.reason}
                </li>
              ))}
            </ul>
          : null}
      </AlertDescription>
    </Alert>
  );
}

function Unmatched({ rows, loading }) {
  const columns = [
    {
      accessorKey: "name",
      header: "Applicant",
      meta: { className: "[&:is(td)]:align-top" },
      cell: ({ row }) => (
        <div className="whitespace-normal">
          <div className="font-medium text-foreground">{row.original.name}</div>
          <div className="text-xs break-all text-muted-foreground">
            {row.original.email}
          </div>
        </div>
      ),
    },
    {
      id: "answer",
      header: "What they wrote",
      enableSorting: false,
      meta: { className: "[&:is(td)]:align-top" },
      cell: ({ row }) => (
        <div className="max-w-md space-y-1 whitespace-normal">
          <p className="text-foreground">&ldquo;{row.original.raw}&rdquo;</p>
          {row.original.names.length
            ? <p className="text-xs text-muted-foreground">
                Names without emails: {row.original.names.join(", ")}
              </p>
            : null}
        </div>
      ),
    },
    {
      id: "team",
      header: "Team",
      accessorFn: (r) => r.team?.name || "",
      meta: { className: "[&:is(td)]:align-top" },
      cell: ({ row }) =>
        row.original.team
          ? row.original.team.name
          : <span className="text-muted-foreground">None</span>,
    },
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        These applicants wrote something in the teammates question, but no email
        in it, and no full name that matches exactly one applicant. Find their
        teammates by hand, or leave them for team formation.
      </p>
      <DataTable
        columns={columns}
        data={rows || []}
        loading={loading}
        dense
        getRowId={(r) => r.applicationId}
        emptyState={
          <EmptyState
            icon={CircleCheck}
            title="Every answer matched someone."
          />
        }
      />
    </div>
  );
}

function Unteamed({ round }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const next = await apiFetch(
        `/api/admin/team-builder/unteamed${round ? `?round=${encodeURIComponent(round)}` : ""}`,
      );
      setData(next);
      setGroup((current) =>
        current && next.groups.some((g) => g.value === current)
          ? current
          : next.groups.find((g) => g.count)?.value ||
            next.groups[0]?.value ||
            "",
      );
    } catch (err) {
      setError(err.message);
    }
  }, [round]);

  useEffect(() => {
    load();
  }, [load]);

  async function download(value) {
    setBusy(value || "all");
    try {
      const q = new URLSearchParams();
      if (round) q.set("round", round);
      if (value) q.set("answer", value);
      await downloadFile(
        `/api/admin/team-builder/unteamed.csv?${q.toString()}`,
        "not-on-a-team.csv",
      );
    } catch (err) {
      notifyError(err, { title: "Couldn't download the list" });
    } finally {
      setBusy("");
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {error}
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const current = data.groups.find((g) => g.value === group);
  const columns = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div className="whitespace-normal">
          <div className="font-medium text-foreground">{row.original.name}</div>
          <div className="text-xs break-all text-muted-foreground">
            {row.original.email}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "major",
      header: "Major",
      meta: { className: "hidden sm:table-cell" },
    },
    {
      accessorKey: "pairing",
      header: data.questions.pairing ? "Pairing preference" : "Pairing",
      cell: ({ row }) =>
        row.original.pairing || (
          <span className="text-muted-foreground">No answer</span>
        ),
    },
    {
      accessorKey: "formationEvent",
      header: "Team formation event",
      meta: { className: "hidden md:table-cell" },
      cell: ({ row }) => (
        <span className="whitespace-normal">
          {row.original.formationEvent || (
            <span className="text-muted-foreground">No answer</span>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">
          {plural(data.total, "accepted applicant")} on no team and with no
          pending invite
          {data.questions.research
            ? `, by their answer to "${data.questions.research.label}".`
            : ". This form has no research-study question."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!data.total || Boolean(busy)}
          loading={busy === "all"}
          onClick={() => download("")}
        >
          <Download aria-hidden="true" />
          Download everyone
        </Button>
      </div>

      <fieldset className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="sr-only">Research study answer</legend>
        {data.groups.map((g) => (
          <button
            key={g.value}
            type="button"
            aria-pressed={g.value === group}
            onClick={() => setGroup(g.value)}
            className={cn(
              "rounded-lg px-3 py-2 text-left ring-1 ring-foreground/10 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              g.value === group ? "bg-brand/12 ring-ring" : "bg-card",
            )}
          >
            <div className="text-2xl font-semibold tracking-tight tabular-nums">
              {number(g.count)}
            </div>
            <div className="line-clamp-2 text-xs text-muted-foreground">
              {g.label}
            </div>
          </button>
        ))}
      </fieldset>

      {current
        ? <DataTable
            key={current.value}
            columns={columns}
            data={current.people}
            dense
            getRowId={(r) => r.applicationId}
            toolbar={
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold">
                  {current.label === "No answer" || current.value === NO_ANSWER
                    ? current.label
                    : `"${current.label}"`}
                </h2>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!current.count || Boolean(busy)}
                  loading={busy === current.value}
                  onClick={() => download(current.value)}
                >
                  <Download aria-hidden="true" />
                  Download this group
                </Button>
              </div>
            }
            emptyState={
              <EmptyState icon={UsersRound} title="Nobody in this group." />
            }
          />
        : null}
    </div>
  );
}
