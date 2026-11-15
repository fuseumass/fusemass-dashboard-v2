"use client";
import { useCallback, useEffect, useState } from "react";
import CheckInStation from "@/components/CheckInStation";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

export default function JudgingDeskPage() {
  const user = useUser();
  const [result, setResult] = useState(null);
  const [project, setProject] = useState(null);
  const [choice, setChoice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [awaiting, setAwaiting] = useState([]);
  const [awaitingLoading, setAwaitingLoading] = useState(true);
  const staff = ["admin", "moderator"].includes(user.role);
  // Teams that got a table here but nobody has scanned in at that table yet.
  const loadAwaiting = useCallback(async () => {
    try {
      const data = await apiFetch("/api/staff/judging/awaiting-table");
      setAwaiting(data.projects);
    } catch {
      // Keep the last list; the next refresh retries.
    } finally {
      setAwaitingLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!staff) return undefined;
    loadAwaiting();
    const timer = setInterval(loadAwaiting, 30000);
    return () => clearInterval(timer);
  }, [staff, loadAwaiting]);
  if (!staff) return null;
  async function check(qrId, projectId) {
    if (busy) return;
    setBusy(true);
    setChoice(null);
    setProject(null);
    try {
      const data = await apiFetch("/api/staff/judging/desk-checkin", {
        method: "POST",
        body: JSON.stringify({ qrId, projectId }),
      });
      setProject(data.project);
      setResult({
        kind: "success",
        message: data.project.name,
        warning: data.alreadyAssigned
          ? "Already assigned"
          : "Desk check-in complete",
      });
    } catch (err) {
      setResult({ kind: "error", message: err.message });
      if (err.data?.projects) setChoice({ qrId, projects: err.data.projects });
    } finally {
      setBusy(false);
      loadAwaiting();
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader title="Judging desk" />
      <CheckInStation
        title="Scan attendee QR"
        onCode={(code) => check(code)}
        result={result}
      />
      {choice && (
        <div className="flex flex-wrap gap-2">
          {choice.projects.map((p) => (
            <Button
              key={p._id}
              size="lg"
              className="max-w-full pointer-coarse:h-11"
              disabled={busy}
              onClick={() => check(choice.qrId, p._id)}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}
      {project && (
        <div
          className="space-y-2 rounded-lg border bg-card p-6"
          aria-live="polite"
        >
          <p className="text-3xl font-semibold tabular-nums wrap-anywhere sm:text-4xl">
            Table {project.tableNumber} in {project.room?.name}
          </p>
          <p>{project.name}</p>
          <p className="text-sm text-muted-foreground">
            {project.members?.map((m) => m.name).join(", ")}
          </p>
          <p className="text-sm text-muted-foreground">
            Go to your table and scan its QR from your dashboard.
          </p>
        </div>
      )}
      <section className="space-y-3" aria-labelledby="awaiting-table">
        <h2 id="awaiting-table" className="text-base font-semibold">
          Not at their table yet ({awaiting.length})
        </h2>
        <p className="text-sm text-muted-foreground">
          Teams with a table that nobody has scanned in at. Refreshes every 30
          seconds.
        </p>
        <DataTable
          columns={[
            { accessorKey: "tableNumber", header: "Table" },
            { accessorKey: "room", header: "Room" },
            {
              accessorKey: "name",
              header: "Project",
              meta: { className: "min-w-40 whitespace-normal" },
            },
            {
              id: "members",
              header: "Members",
              meta: { className: "min-w-40 whitespace-normal" },
              cell: ({ row }) => row.original.members.join(", "),
            },
            {
              id: "since",
              header: "Desk check-in",
              cell: ({ row }) =>
                new Date(row.original.deskCheckedInAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                }),
            },
          ]}
          data={awaiting}
          loading={awaitingLoading}
          emptyState={
            <EmptyState
              title="Everyone is at their table"
              description="Teams appear here after their desk check-in until they scan their table QR."
            />
          }
        />
      </section>
    </div>
  );
}
