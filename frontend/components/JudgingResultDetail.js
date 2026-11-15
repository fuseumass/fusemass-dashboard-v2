"use client";

import { useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";

const fixed = (value) => (value == null ? "—" : Number(value).toFixed(2));
const signed = (value) =>
  value == null ? "—" : `${value > 0 ? "+" : ""}${Number(value).toFixed(3)}`;

/**
 * Everything about one project in the judging results: what was imported,
 * where it sits, every judge's raw criterion scores and comments, their
 * calibration bias and the bias-adjusted totals used for ranking, and which
 * assigned judges are still to score it.
 * @param {object} props - Props.
 * @param {string|null} props.projectId - Project to show, or null when closed.
 * @param {Function} props.onClose - Called when the dialog closes.
 * @returns {JSX.Element} The dialog.
 */
export default function JudgingResultDetail({ projectId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setData(null);
    setError("");
    apiFetch(`/api/admin/judging/results/projects/${projectId}`)
      .then((result) => live && setData(result))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [projectId]);
  const p = data?.project;
  const s = data?.summary;
  const criteria = data?.criteria || [];
  const scoreColumns = [
    { accessorKey: "judge", header: "Judge" },
    ...criteria.map((c) => ({
      id: c.key,
      header: `${c.label} (${c.min}–${c.max}${c.weight !== 1 ? `, ×${c.weight}` : ""})`,
      cell: ({ row }) => row.original.scores?.[c.key] ?? "—",
    })),
    {
      id: "raw",
      header: "Raw general / category",
      cell: ({ row }) =>
        `${fixed(row.original.rawGeneral)} / ${fixed(row.original.rawCategory)}`,
    },
    {
      id: "bias",
      header: "Judge bias (general / category)",
      cell: ({ row }) =>
        row.original.bias
          ? `${signed(row.original.bias.general)} / ${signed(row.original.bias.category)}`
          : "Not calibrated",
    },
    {
      id: "adjusted",
      header: "Adjusted general / category",
      cell: ({ row }) =>
        `${fixed(row.original.adjustedGeneral)} / ${fixed(row.original.adjustedCategory)}`,
    },
    {
      accessorKey: "comments",
      header: "Comments",
      meta: { className: "min-w-56 whitespace-pre-wrap" },
      cell: ({ row }) => row.original.comments || "—",
    },
    {
      id: "when",
      header: "Scored",
      cell: ({ row }) => formatDateTime(row.original.updatedAt),
    },
  ];
  const statusLabel = {
    scored: "Scored",
    skipped: "Skipped",
    pending: "Not yet",
  };
  return (
    <Dialog
      open={Boolean(projectId)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{p?.name || "Project"}</DialogTitle>
          <DialogDescription>
            {p
              ? `${p.tableNumber ? `Table ${p.tableNumber}` : "No table"}${p.room ? ` in ${p.room}` : ""} · ${p.category || "No category"}`
              : "Loading project"}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!data && !error && <Skeleton className="h-64 w-full" />}
        {data && (
          <div className="space-y-6">
            <section className="space-y-2" aria-labelledby="detail-totals">
              <h3 id="detail-totals" className="text-sm font-semibold">
                Totals
              </h3>
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <div>
                  <dt className="inline text-muted-foreground">Scores: </dt>
                  <dd className="inline">
                    {s?.scoreCount ?? 0}
                    {data.judgingsPerProject
                      ? ` (target ${data.judgingsPerProject})`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">
                    Overall / category rank:{" "}
                  </dt>
                  <dd className="inline">
                    {s?.overallRank ?? "—"} / {s?.categoryRank ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">
                    Raw general / category:{" "}
                  </dt>
                  <dd className="inline">
                    {fixed(s?.rawGeneral)} / {fixed(s?.rawCategory)}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">
                    Adjusted general / category:{" "}
                  </dt>
                  <dd className="inline">
                    {fixed(s?.adjustedGeneral)} / {fixed(s?.adjustedCategory)}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap gap-1">
                {s?.flags?.missingScores && (
                  <Badge variant="outline">Too few scores</Badge>
                )}
                {s?.flags?.noCalibration && (
                  <Badge variant="outline">Uncalibrated judge in average</Badge>
                )}
                {p.withdrawn && <Badge variant="outline">Withdrawn</Badge>}
                {p.hardware && <Badge variant="outline">Hardware</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                A judge's weighted total minus their bias times the criteria
                weights (general ×{data.weights.general}, category ×
                {data.weights.category}) gives their adjusted total; the
                project's adjusted total is the average.
              </p>
            </section>
            <section className="space-y-2" aria-labelledby="detail-scores">
              <h3 id="detail-scores" className="text-sm font-semibold">
                Judge scores
              </h3>
              <DataTable
                columns={scoreColumns}
                data={data.scores}
                dense
                emptyState="No scores yet"
              />
            </section>
            <section className="space-y-2" aria-labelledby="detail-assigned">
              <h3 id="detail-assigned" className="text-sm font-semibold">
                Assigned judges
              </h3>
              <DataTable
                columns={[
                  { accessorKey: "judge", header: "Judge" },
                  {
                    id: "group",
                    header: "Group",
                    cell: ({ row }) =>
                      row.original.hardwareJudge ? "Hardware" : "General",
                  },
                  {
                    id: "status",
                    header: "Status",
                    cell: ({ row }) => statusLabel[row.original.status],
                  },
                  {
                    id: "position",
                    header: "Place in their list",
                    cell: ({ row }) =>
                      `${row.original.position} of ${row.original.queueLength}`,
                  },
                ]}
                data={data.assigned}
                dense
                emptyState="No judge in the active assignment has this project"
              />
            </section>
            <section className="space-y-2" aria-labelledby="detail-project">
              <h3 id="detail-project" className="text-sm font-semibold">
                Project
              </h3>
              <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <dt className="inline text-muted-foreground">Devpost: </dt>
                  <dd className="inline break-all">
                    <a
                      href={p.devpostUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link underline"
                    >
                      {p.devpostUrl}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">Team: </dt>
                  <dd className="inline">
                    {p.team || "Not linked"}
                    {p.leader ? ` (lead ${p.leader})` : ""}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">Members: </dt>
                  <dd className="inline">{p.members.join(", ") || "None"}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="inline text-muted-foreground">
                    Opt-in prizes:{" "}
                  </dt>
                  <dd className="inline">
                    {p.optInPrizes.join("; ") || "None"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">
                    Desk check-in:{" "}
                  </dt>
                  <dd className="inline">
                    {p.deskCheckedInAt
                      ? formatDateTime(p.deskCheckedInAt)
                      : "Not yet"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">
                    Table check-in:{" "}
                  </dt>
                  <dd className="inline">
                    {p.tableCheckedInAt
                      ? formatDateTime(p.tableCheckedInAt)
                      : "Not yet"}
                  </dd>
                </div>
                {p.unmatchedMembers.length > 0 && (
                  <div className="sm:col-span-2">
                    <dt className="inline text-muted-foreground">
                      Not matched to an account:{" "}
                    </dt>
                    <dd className="inline">
                      {p.unmatchedMembers
                        .map((m) => [m.name, m.email].filter(Boolean).join(" "))
                        .join("; ")}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
