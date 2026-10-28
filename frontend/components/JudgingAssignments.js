"use client";

import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { apiFetch } from "@/lib/api";

const root = "/api/admin/judging";
export default function JudgingAssignments({ projects, onChange }) {
  const [data, setData] = useState(null);
  const [judges, setJudges] = useState([]);
  const [count, setCount] = useState("3");
  const [minutes, setMinutes] = useState("");
  const [judge, setJudge] = useState("");
  const [projectIds, setProjectIds] = useState([]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmation, setConfirmation] = useState(null);
  const load = useCallback(async () => {
    try {
      const [versions, people] = await Promise.all([
        apiFetch(`${root}/assignments`),
        apiFetch("/api/admin/judges"),
      ]);
      setData(versions);
      setJudges(people.judges);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function action(path, body, method = "POST") {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await apiFetch(`${root}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (result.verifierReport) setReport(result.verifierReport);
      setMessage("Assignments updated");
      setConfirmation(null);
      await load();
      if (onChange) await onChange();
    } catch (err) {
      setError(err.message);
      if (err.data?.verifierReport) setReport(err.data.verifierReport);
    } finally {
      setBusy(false);
    }
  }
  const active = data?.versions.find((v) => v.version === data.activeVersion);
  return (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">Assignments</h2>
      <AlertDialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmation?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={busy}
              onClick={() =>
                action(
                  confirmation.path,
                  undefined,
                  confirmation.method || "POST",
                )
              }
            >
              {confirmation?.title}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm" aria-live="polite">
        {message}
      </p>
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setReport(null);
          action("/assignments", {
            judgingsPerProject: Number(count),
            slotMinutes: minutes === "" ? null : Number(minutes),
          });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="assignment-count">Judgings per project</Label>
          <Input
            id="assignment-count"
            type="number"
            min="1"
            max="100"
            required
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slot-minutes">Slot minutes (optional)</Label>
          <Input
            id="slot-minutes"
            type="number"
            min="0.1"
            step="0.1"
            max="240"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
        <Button type="submit" loading={busy}>
          Generate version
        </Button>
      </form>
      <p className="text-xs text-muted-foreground">
        Only projects with both check-ins are included. Hardware judges form a
        separate pool. Generation does not activate a version.
      </p>
      {report && (
        <div className="space-y-2" aria-live="polite">
          {report.map((r) => (
            <details
              key={r.pool}
              open={!r.success}
              className="rounded-md border p-3 text-sm"
            >
              <summary>
                {r.pool === "hardware" ? "Hardware" : "Regular"}:{" "}
                {r.success ? "Verifier passed" : "Verifier failed"}
              </summary>
              <ul>
                {r.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {r.log?.join("\n")}
              </pre>
            </details>
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Verifier reports describe the original generation. Late edits can change
        coverage and workload.
      </p>
      <DataTable
        data={data?.versions || []}
        loading={!data && !error}
        emptyState="No assignment versions yet"
        columns={[
          { accessorKey: "version", header: "Version" },
          {
            accessorKey: "params.judgingsPerProject",
            header: "Judgings per project",
          },
          {
            id: "judges",
            header: "Judges",
            cell: ({ row }) => row.original.queues.length,
          },
          {
            id: "report",
            header: "Verification",
            cell: ({ row }) => (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReport(row.original.verifierReport)}
              >
                View report
              </Button>
            ),
          },
          {
            id: "activate",
            header: "Activation",
            cell: ({ row }) => (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || row.original.version === data?.activeVersion}
                onClick={() =>
                  action(`/assignments/${row.original.version}/activate`)
                }
              >
                {row.original.version === data?.activeVersion
                  ? "Active"
                  : "Activate"}
              </Button>
            ),
          },
        ]}
      />
      {data && (
        <div className="flex items-center gap-4">
          <p className="text-sm">
            {data.judgingOpen ? "Judging is open" : "Judging is closed"}
          </p>
          <Button
            variant="outline"
            loading={busy}
            onClick={() => action(data.judgingOpen ? "/close" : "/open")}
          >
            {data.judgingOpen ? "Close judging" : "Open judging"}
          </Button>
        </div>
      )}
      {active && (
        <>
          <h3 className="text-sm font-medium">Late judge changes</h3>
          <p className="text-xs text-muted-foreground">
            Add a judge with selected projects. Their slots follow the existing
            schedule. Removing a judge preserves their scores. These changes may
            reduce or increase project coverage; review the queues before
            continuing.
          </p>
          <div className="space-y-2">
            <Label htmlFor="late-judge">Judge</Label>
            <Select value={judge} onValueChange={setJudge}>
              <SelectTrigger id="late-judge">
                <SelectValue placeholder="Choose a judge" />
              </SelectTrigger>
              <SelectContent>
                {judges
                  .filter((j) => j.judgeProfile?.active !== false)
                  .map((j) => (
                    <SelectItem key={j._id} value={j._id}>
                      {j.name} ({j.email})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3">
            {projects
              .filter(
                (p) => !p.withdrawn && p.deskCheckedInAt && p.tableCheckedInAt,
              )
              .map((p) => (
                <div key={p._id} className="flex items-center gap-2">
                  <Checkbox
                    id={`late-${p._id}`}
                    checked={projectIds.includes(p._id)}
                    onCheckedChange={(checked) =>
                      setProjectIds((ids) =>
                        checked
                          ? [...ids, p._id]
                          : ids.filter((id) => id !== p._id),
                      )
                    }
                  />
                  <Label htmlFor={`late-${p._id}`}>
                    {p.name} · Table {p.tableNumber}
                    {p.hardware ? " · Hardware" : ""}
                  </Label>
                </div>
              ))}
          </div>
          <Button
            variant="outline"
            disabled={busy || !judge || !projectIds.length}
            loading={busy}
            onClick={() =>
              action("/assignments/judges", { judgeId: judge, projectIds })
            }
          >
            Add judge to active version
          </Button>
          <DataTable
            data={active.queues}
            emptyState="No judge queues"
            columns={[
              {
                id: "judge",
                header: "Judge",
                cell: ({ row }) =>
                  judges.find((j) => j._id === row.original.judge)?.name ||
                  row.original.judge,
              },
              {
                id: "projects",
                header: "Project queue",
                cell: ({ row }) => (
                  <details>
                    <summary>{row.original.projects.length} projects</summary>
                    <ol className="space-y-1 py-2">
                      {row.original.projects.map((id, index) => {
                        const project = projects.find((p) => p._id === id);
                        return (
                          <li key={id}>
                            {index + 1}. {project?.name || "Unknown project"} ·
                            Table {project?.tableNumber} · {project?.room?.name}{" "}
                            · Slot {row.original.slots.indexOf(id) + 1}
                          </li>
                        );
                      })}
                    </ol>
                  </details>
                ),
              },
              {
                id: "remove",
                header: "Action",
                cell: ({ row }) => (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        path: `/assignments/judges/${row.original.judge}`,
                        method: "DELETE",
                        title: "Remove judge from queue",
                        description:
                          "Remove this judge's active queue. Their scores will be kept.",
                      })
                    }
                  >
                    Remove from queue
                  </Button>
                ),
              },
            ]}
          />
          <h3 className="text-sm font-medium">Withdraw a project</h3>
          <DataTable
            data={projects.filter((p) => !p.withdrawn)}
            emptyState="No active projects"
            columns={[
              { accessorKey: "name", header: "Project" },
              { accessorKey: "tableNumber", header: "Table" },
              {
                id: "withdraw",
                header: "Action",
                cell: ({ row }) => (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        path: `/projects/${row.original._id}/withdraw`,
                        title: "Withdraw project",
                        description: `Remove ${row.original.name} from every active queue. Existing scores will be kept.`,
                      })
                    }
                  >
                    Withdraw from all queues
                  </Button>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
