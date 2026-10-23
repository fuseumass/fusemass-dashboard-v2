"use client";

import { Download, RefreshCw, UsersRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import SearchInput from "@/components/SearchInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

// Every team (moderators + admins): members with their application status,
// and the Devpost link judging uses to match each project to its team.
export default function StaffTeamsPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";
  const [teams, setTeams] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch("/api/admin/teams")
      .then((data) => setTeams(data.teams))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
    else load();
  }, [isStaff, router, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (teams || []).filter(
      (t) =>
        (!missingOnly || !t.devpostUrl) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.members.some((m) =>
            `${m.name} ${m.email}`.toLowerCase().includes(q),
          )),
    );
  }, [teams, query, missingOnly]);

  if (!isStaff) return null;

  function downloadCsv() {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [
        "Team",
        "Devpost URL",
        "Member",
        "Email",
        "Leader",
        "Application status",
      ],
    ];
    for (const t of visible) {
      for (const m of t.members) {
        rows.push([
          t.name,
          t.devpostUrl,
          m.name,
          m.email,
          m.leader ? "yes" : "",
          m.applicationStatus,
        ]);
      }
    }
    const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "teams.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const withLink = (teams || []).filter((t) => t.devpostUrl).length;

  const columns = [
    {
      accessorKey: "name",
      header: "Team",
      meta: { className: "[&:is(td)]:align-top" },
      cell: ({ row }) => {
        const t = row.original;
        return (
          <div>
            <div className="font-medium text-foreground">{t.name}</div>
            {t.pendingInvites
              ? <div className="text-xs text-muted-foreground">
                  {t.pendingInvites} pending invite
                  {t.pendingInvites === 1 ? "" : "s"}
                </div>
              : null}
          </div>
        );
      },
    },
    {
      id: "members",
      header: "Members",
      enableSorting: false,
      meta: { className: "[&:is(td)]:align-top" },
      cell: ({ row }) => (
        <ul className="space-y-1">
          {row.original.members.map((m) => (
            <li key={m._id} className="flex flex-wrap items-center gap-x-2">
              <span className="text-foreground">{m.name}</span>
              {m.leader
                ? <span className="text-xs text-muted-foreground">Leader</span>
                : null}
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {m.email}
              </span>
              <ApplicationStatusBadge
                status={m.applicationStatus}
                label={
                  m.applicationStatus === "none" ? "No application" : undefined
                }
              />
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: "devpost",
      header: "Devpost",
      accessorFn: (t) => t.devpostUrl || "",
      meta: { className: "[&:is(td)]:align-top" },
      cell: ({ row }) => {
        const url = row.original.devpostUrl;
        return url
          ? <a
              className="break-all text-link hover:underline"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {url.replace("https://devpost.com/software/", "")}
            </a>
          : <span className="text-muted-foreground">Not added</span>;
      },
    },
  ];

  const toolbar = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Search teams"
          placeholder="Search team, member or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="sm:w-64"
        />
        <div className="flex items-center gap-2 px-1">
          <Switch
            id="missing-devpost"
            size="sm"
            checked={missingOnly}
            onCheckedChange={setMissingOnly}
          />
          <Label htmlFor="missing-devpost" className="text-sm font-normal">
            No Devpost link
          </Label>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!visible.length}
            onClick={downloadCsv}
          >
            <Download aria-hidden="true" />
            Download CSV
          </Button>
        </div>
      </div>
      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Teams"
        description={
          teams
            ? `${teams.length} teams, ${withLink} with a Devpost link.`
            : undefined
        }
      />
      <DataTable
        columns={columns}
        data={visible}
        loading={!teams && !error}
        dense
        getRowId={(t) => t._id}
        toolbar={toolbar}
        emptyState={
          <EmptyState
            icon={UsersRound}
            title={teams?.length ? "No teams match" : "No teams yet"}
            description={
              teams?.length
                ? "Change the search or the filter."
                : "Teams appear here once applicants create them."
            }
          />
        }
      />
    </div>
  );
}
