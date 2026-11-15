"use client";

import { useState } from "react";
import DataTable from "@/components/DataTable";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
const AUTO = "auto";

/**
 * Move a range of a judge's unscored tables to the end of another judge's
 * sheet. The server plans it (flagging judges who already saw a project and
 * suggesting ones who haven't); the admin can change any row, then apply.
 * @param {object} props - Props.
 * @param {object} props.active - Active assignment version (queues).
 * @param {object[]} props.judges - Judges from /api/admin/judges.
 * @param {Function} props.onDone - Called after a move is saved.
 * @returns {JSX.Element} The move tool.
 */
export default function JudgingMoveTables({ active, judges, onDone }) {
  const [from, setFrom] = useState("");
  const [tableFrom, setTableFrom] = useState("");
  const [tableTo, setTableTo] = useState("");
  const [target, setTarget] = useState(AUTO);
  const [plan, setPlan] = useState(null);
  const [choices, setChoices] = useState({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const nameOf = (id) => judges.find((j) => j._id === id)?.name || "Judge";
  const queueJudges = active.queues.map((q) => q.judge);

  async function makePlan() {
    setBusy(true);
    setError("");
    setMessage("");
    setPlan(null);
    try {
      const result = await apiFetch(`${root}/assignments/move/plan`, {
        method: "POST",
        body: JSON.stringify({
          fromJudgeId: from,
          tableFrom: Number(tableFrom),
          tableTo: Number(tableTo || tableFrom),
          toJudgeId: target === AUTO ? null : target,
        }),
      });
      setPlan(result);
      setChoices(
        Object.fromEntries(
          result.moves.map((m) => [m.projectId, m.judgeId || ""]),
        ),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    const moves = plan.moves
      .filter((m) => choices[m.projectId])
      .map((m) => ({ projectId: m.projectId, judgeId: choices[m.projectId] }));
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch(`${root}/assignments/move`, {
        method: "POST",
        body: JSON.stringify({ fromJudgeId: plan.fromJudgeId, moves }),
      });
      setMessage(
        `Moved ${result.moved} project${result.moved === 1 ? "" : "s"}.`,
      );
      setPlan(null);
      if (onDone) await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = plan ? plan.moves.filter((m) => choices[m.projectId]) : [];
  return (
    <div className="space-y-3 rounded-md border p-4">
      <h3 className="text-sm font-medium">Move tables to another judge</h3>
      <p className="text-xs text-muted-foreground">
        Pick a judge and a range of their tables. Only tables they haven't
        scored move, to the end of the other judge's sheet. Nobody gets a
        project they've already seen, and hardware projects only go to hardware
        judges.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor="move-from">From judge</Label>
          <Select
            value={from}
            onValueChange={(v) => {
              setFrom(v);
              setPlan(null);
            }}
          >
            <SelectTrigger id="move-from">
              <SelectValue placeholder="Choose a judge" />
            </SelectTrigger>
            <SelectContent>
              {queueJudges.map((id) => (
                <SelectItem key={id} value={id}>
                  {nameOf(id)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="move-table-from">From table</Label>
          <Input
            id="move-table-from"
            inputMode="numeric"
            value={tableFrom}
            onChange={(e) => setTableFrom(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="move-table-to">To table</Label>
          <Input
            id="move-table-to"
            inputMode="numeric"
            placeholder={tableFrom || ""}
            value={tableTo}
            onChange={(e) => setTableTo(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="move-target">Move to</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="move-target">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>
                Auto: judges who haven't seen them
              </SelectItem>
              {judges
                .filter(
                  (j) =>
                    j._id !== from &&
                    j.inviteStatus === "accepted" &&
                    j.judgeProfile?.active !== false,
                )
                .map((j) => (
                  <SelectItem key={j._id} value={j._id}>
                    {j.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button
        variant="outline"
        disabled={busy || !from || !tableFrom}
        loading={busy && !plan}
        onClick={makePlan}
      >
        Plan move
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <p className="text-sm text-success" aria-live="polite">
          {message}
        </p>
      )}
      {plan && (
        <>
          {plan.moves.some((m) => m.conflict) && (
            <Alert variant="warning">
              <AlertDescription>
                Some tables can't go where you asked. Each one below has a
                suggested judge who hasn't seen it; change it if you like.
              </AlertDescription>
            </Alert>
          )}
          <DataTable
            data={plan.moves}
            emptyState="Nothing to move"
            columns={[
              { accessorKey: "tableNumber", header: "Table" },
              {
                accessorKey: "name",
                header: "Project",
                meta: { className: "min-w-32 whitespace-normal" },
              },
              {
                id: "to",
                header: "Moves to",
                cell: ({ row }) => {
                  const m = row.original;
                  const options = m.alternatives;
                  if (!options.length)
                    return (
                      <span className="text-destructive">Stays (no judge)</span>
                    );
                  return (
                    <Select
                      value={choices[m.projectId] || ""}
                      onValueChange={(v) =>
                        setChoices({ ...choices, [m.projectId]: v })
                      }
                    >
                      <SelectTrigger
                        aria-label={`Judge for table ${m.tableNumber}`}
                        className="w-48"
                      >
                        <SelectValue placeholder="Choose a judge" />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((o) => (
                          <SelectItem key={o.judgeId} value={o.judgeId}>
                            {o.name} ({o.remaining} left)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                },
              },
              {
                id: "note",
                header: "Note",
                meta: { className: "min-w-48 whitespace-normal" },
                cell: ({ row }) =>
                  row.original.conflict
                    ? <span className="text-warning">
                        {row.original.conflict}
                      </span>
                    : null,
              },
            ]}
          />
          <Button
            disabled={busy || !ready.length}
            loading={busy}
            onClick={apply}
          >
            Move {ready.length} project{ready.length === 1 ? "" : "s"}
          </Button>
        </>
      )}
    </div>
  );
}
