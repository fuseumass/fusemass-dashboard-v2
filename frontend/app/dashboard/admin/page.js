"use client";

import {
  Check,
  Clock,
  Flag,
  FlagOff,
  Inbox,
  MoreHorizontal,
  PanelRightOpen,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlagBadge, FlagPanel } from "@/components/ApplicationFlags";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { plainText } from "@/components/RichText";
import SearchInput from "@/components/SearchInput";
import SignedLinkButton from "@/components/SignedLinkButton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

const STATUS_OPTIONS = [
  ["all", "All statuses"],
  ["draft", "Draft"],
  ["pending", "Pending"],
  ["accepted", "Accepted"],
  ["rejected", "Rejected"],
  ["waitlisted", "Waitlisted"],
];
const DECISIONS = [
  ["accepted", "Accept", Check],
  ["waitlisted", "Waitlist", Clock],
  ["rejected", "Reject", X],
];
const STALE_MS = 5 * 60 * 1000;

// Kept at module scope, so it survives navigating away and back: returning to
// Review shows the last list straight away instead of downloading it again.
// The server is only asked again by Refresh; decisions update rows in place.
// Tied to the logged-in user, so someone else signing in on the same tab
// never sees the previous reviewer's cached applications.
const reviewCache = {
  userId: null,
  list: null,
  fetchedAt: null,
  details: new Map(),
};

function cacheFor(userId) {
  if (reviewCache.userId !== userId) {
    reviewCache.userId = userId;
    reviewCache.list = null;
    reviewCache.fetchedAt = null;
    reviewCache.details = new Map();
  }
  return reviewCache;
}

export default function AdminReviewPage() {
  const user = useUser();
  const cache = cacheFor(user._id);
  const [applications, setApplications] = useState(() => cache.list || []);
  const [fetchedAt, setFetchedAt] = useState(cache.fetchedAt);
  const [loading, setLoading] = useState(!cache.list);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState("all");
  const [round, setRound] = useState("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [deciding, setDeciding] = useState(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/applications");
      cache.list = data.applications;
      cache.fetchedAt = new Date();
      cache.details = new Map();
      setApplications(cache.list);
      setFetchedAt(cache.fetchedAt);
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [cache]);

  // Fetch when there's nothing cached, or quietly in the background (the
  // cached list stays on screen) when it's over STALE_MS old, so decisions
  // other reviewers made in the meantime show up without a manual Refresh.
  useEffect(() => {
    if (!cache.list || Date.now() - cache.fetchedAt.getTime() > STALE_MS) {
      refresh();
    }
  }, [cache, refresh]);

  // Rounds for the filter, from the applications themselves (no extra
  // request, and it works for moderators as well as admins).
  const rounds = useMemo(() => {
    const byId = new Map();
    for (const app of applications) {
      if (app.round?._id) byId.set(app.round._id, app.round.name);
    }
    return [...byId].map(([id, name]) => ({ _id: id, name }));
  }, [applications]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return applications.filter(
      (app) =>
        (status === "all" || app.status === status) &&
        (round === "all" || app.round?._id === round) &&
        (!flaggedOnly || app.flagged) &&
        (!q ||
          `${app.applicant?.name || ""} ${app.applicant?.email || ""} ${app.university || ""}`
            .toLowerCase()
            .includes(q)),
    );
  }, [applications, status, round, flaggedOnly, search]);
  const flaggedCount = useMemo(
    () => applications.filter((app) => app.flagged).length,
    [applications],
  );
  const pendingCount = useMemo(
    () => applications.filter((app) => app.status === "pending").length,
    [applications],
  );

  // A flag was set or cleared in the drawer: keep the table row and the
  // cached detail in step with the server's answer.
  function flagChanged(updated) {
    setApplications((prev) => {
      const next = prev.map((app) =>
        app._id === updated._id ? { ...app, flagged: updated.flagged } : app,
      );
      cache.list = next;
      return next;
    });
    const detail = cache.details.get(updated._id);
    if (detail) {
      cache.details.set(updated._id, {
        ...detail,
        flagged: updated.flagged,
        flagReasons: updated.flagReasons,
        flaggedBy: updated.flaggedBy,
      });
    }
  }

  async function clearFlag(id) {
    setError("");
    try {
      const data = await apiFetch(`/api/admin/applications/${id}/flag`, {
        method: "DELETE",
      });
      flagChanged(data.application);
    } catch (err) {
      setError(err.message);
    }
  }

  async function decide(id, decision) {
    setError("");
    setDeciding(id);
    try {
      const data = await apiFetch(`/api/admin/applications/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      });
      const updated = data.application;
      setApplications((prev) => {
        const next = prev.map((app) =>
          app._id === id
            ? { ...app, status: updated.status, updatedAt: updated.updatedAt }
            : app,
        );
        cache.list = next;
        return next;
      });
      const detail = cache.details.get(id);
      if (detail) cache.details.set(id, { ...detail, status: updated.status });
      notifySuccess(`Marked as ${updated.status}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeciding(null);
    }
  }

  const selected = applications.find((app) => app._id === selectedId) || null;

  const columns = [
    {
      id: "applicant",
      header: "Applicant",
      accessorFn: (app) => app.applicant?.name || "",
      cell: ({ row }) => {
        const app = row.original;
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">
                {app.applicant ? app.applicant.name : "Unknown"}
              </span>
              {app.flagged ? <FlagBadge /> : null}
            </div>
            <div className="truncate text-xs text-muted-foreground md:hidden">
              {app.applicant?.email}
            </div>
          </div>
        );
      },
    },
    {
      id: "email",
      header: "Email",
      accessorFn: (app) => app.applicant?.email || "",
      meta: { className: "hidden text-muted-foreground md:table-cell" },
    },
    {
      accessorKey: "university",
      header: "University",
      meta: { className: "hidden text-muted-foreground lg:table-cell" },
    },
    {
      id: "round",
      header: "Round",
      accessorFn: (app) => app.round?.name || "",
      meta: { className: "hidden text-muted-foreground lg:table-cell" },
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <ApplicationStatusBadge status={row.original.status} />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { className: "w-10 text-right" },
      cell: ({ row }) => {
        const app = row.original;
        const name = app.applicant?.name || "applicant";
        // The menu renders in a portal, but React events still bubble to the
        // row, which would open the drawer. Keep clicks inside the menu.
        const keep = (event) => event.stopPropagation();
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${name}`}
                disabled={deciding === app._id}
                onClick={keep}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={keep}>
              {DECISIONS.map(([decision, label, Icon]) => (
                <DropdownMenuItem
                  key={decision}
                  disabled={deciding === app._id || app.status === decision}
                  onSelect={() => decide(app._id, decision)}
                >
                  <Icon aria-hidden="true" />
                  {label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              {app.flagged
                ? <DropdownMenuItem onSelect={() => clearFlag(app._id)}>
                    <FlagOff aria-hidden="true" />
                    Clear flag
                  </DropdownMenuItem>
                : <DropdownMenuItem onSelect={() => setSelectedId(app._id)}>
                    <Flag aria-hidden="true" />
                    Flag
                  </DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => setSelectedId(app._id)}>
                <PanelRightOpen aria-hidden="true" />
                Open
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <SearchInput
        label="Search applications"
        placeholder="Search applicants"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="sm:w-48"
      />
      <Select value={status} onValueChange={setStatus}>
        <SelectTrigger size="sm" aria-label="Status" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {rounds.length > 1
        ? <Select value={round} onValueChange={setRound}>
            <SelectTrigger size="sm" aria-label="Round" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All rounds</SelectItem>
              {rounds.map((r) => (
                <SelectItem key={r._id} value={r._id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        : null}
      <div className="flex items-center gap-2 px-1">
        <Switch
          id="flagged-only"
          size="sm"
          checked={flaggedOnly}
          onCheckedChange={setFlaggedOnly}
        />
        <Label htmlFor="flagged-only" className="text-sm font-normal">
          Flagged only
          <span className="ml-1.5 tabular-nums text-muted-foreground">
            {flaggedCount}
          </span>
        </Label>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {loading
            ? ""
            : `${visible.length} of ${applications.length}` +
              (fetchedAt
                ? `, updated ${fetchedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : "")}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCw
            className={cn(refreshing && "animate-spin")}
            aria-hidden="true"
          />
          Refresh
        </Button>
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Applications"
        description={
          loading
            ? undefined
            : `${applications.length} applications, ${pendingCount} waiting for a decision.`
        }
      />

      {error
        ? <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}

      <DataTable
        columns={columns}
        data={visible}
        loading={loading}
        dense
        getRowId={(app) => app._id}
        onRowClick={(app) => setSelectedId(app._id)}
        toolbar={toolbar}
        emptyState={
          <EmptyState
            icon={Inbox}
            title={
              applications.length ? "No applications match" : "No applications"
            }
            description={
              applications.length
                ? "Change the filters or the search."
                : "Submitted applications show up here."
            }
          />
        }
      />

      {selected
        ? <ApplicationDrawer
            summary={selected}
            cache={cache}
            onClose={() => setSelectedId(null)}
            onFlagChanged={flagChanged}
            onDecide={decide}
            deciding={deciding === selected._id}
          />
        : null}
    </div>
  );
}

// Detail drawer for one application. The list only has the table's columns,
// so the full application (answers, its round's form) is fetched on open and
// cached; reopening it costs nothing. Escape, the scrim and the close button
// all close it (Sheet).
function ApplicationDrawer({
  summary,
  cache,
  onClose,
  onFlagChanged,
  onDecide,
  deciding,
}) {
  const [app, setApp] = useState(() => cache.details.get(summary._id) || null);
  const [error, setError] = useState("");

  useEffect(() => {
    const cached = cache.details.get(summary._id);
    if (cached) {
      setApp(cached);
      return;
    }
    setApp(null);
    let cancelled = false;
    apiFetch(`/api/admin/applications/${summary._id}`)
      .then((data) => {
        cache.details.set(summary._id, data.application);
        if (!cancelled) setApp(data.application);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cache, summary._id]);

  return (
    <Sheet open onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="shrink-0 gap-1 border-b p-4 pr-12">
          <SheetTitle className="text-base font-semibold">
            {summary.name || summary.applicant?.name}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{summary.applicant?.email}</span>
            <ApplicationStatusBadge status={summary.status} />
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {error
            ? <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            : !app
              ? <p className="text-sm text-muted-foreground">
                  Loading the application
                </p>
              : <>
                  <FlagPanel
                    app={app}
                    onChanged={(updated) => {
                      setApp((prev) => ({
                        ...prev,
                        flagged: updated.flagged,
                        flagReasons: updated.flagReasons,
                        flaggedBy: updated.flaggedBy,
                      }));
                      onFlagChanged(updated);
                    }}
                  />
                  <ApplicationDetails app={app} />
                </>}
        </div>
        <SheetFooter className="shrink-0 flex-row flex-wrap border-t">
          {DECISIONS.map(([decision, label, Icon]) => (
            <Button
              key={decision}
              type="button"
              variant={decision === "accepted" ? "default" : "outline"}
              disabled={deciding || summary.status === decision}
              onClick={() => onDecide(summary._id, decision)}
            >
              <Icon aria-hidden="true" />
              {label}
            </Button>
          ))}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function ApplicationDetails({ app }) {
  return (
    <dl className="divide-y text-sm">
      <Detail label="Phone" value={app.phone} />
      <Detail label="Age" value={app.age} />
      <Detail label="Gender" value={app.gender} />
      <Detail label="Pronouns" value={app.pronouns} />
      <Detail label="Education" value={app.education} />
      <Detail label="University" value={app.university} />
      <Detail label="Major" value={app.major} />
      <Detail label="T-shirt" value={app.tshirtSize} />
      <Detail label="Allergies" value={app.allergies} />
      <Detail
        label="Programming"
        value={(app.programmingSkills || []).join(", ")}
      />
      <Detail label="Hardware" value={(app.hardwareSkills || []).join(", ")} />
      {app.socials
        ? <Detail
            label="Links"
            value={[
              app.socials.linkedin,
              app.socials.github,
              app.socials.website,
            ]
              .filter(Boolean)
              .join(", ")}
          />
        : null}
      <CustomAnswers app={app} />
      {app.hasResume
        ? <DetailRow label="Resume">
            <SignedLinkButton
              path={`/api/admin/applications/${app._id}/resume`}
            >
              View resume
            </SignedLinkButton>
          </DetailRow>
        : null}
    </dl>
  );
}

// Answers to the round's custom questions, labelled from its formConfig.
function CustomAnswers({ app }) {
  const fields = app.round?.formConfig || [];
  const answers = app.answers || {};
  if (!fields.length) return null;

  return fields.map((field) => {
    const value = answers[field.key];
    if (field.type === "resume") {
      // Uploaded resumes open through "View resume" below. Imported
      // applications may carry an external link instead; only https
      // links are made clickable.
      if (app.hasResume || !isHttpsUrl(value)) return null;
      return (
        <DetailRow key={field.key} label={plainText(field.label)}>
          <a
            className="text-link hover:underline"
            href={value}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open resume (external link)
          </a>
        </DetailRow>
      );
    }
    return (
      <Detail
        key={field.key}
        label={plainText(field.label)}
        value={formatAnswer(field, value)}
      />
    );
  });
}

function isHttpsUrl(value) {
  return typeof value === "string" && /^https:\/\/\S+$/i.test(value);
}

function formatAnswer(field, value) {
  if (field.type === "checkbox") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

function DetailRow({ label, children }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

function Detail({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return <DetailRow label={label}>{String(value)}</DetailRow>;
}
