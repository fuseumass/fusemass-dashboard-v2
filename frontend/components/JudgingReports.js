"use client";

import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiDownload, apiFetch } from "@/lib/api";

const root = "/api/admin/judging";
const projectColumns = [
  { accessorKey: "name", header: "Project" },
  { accessorKey: "tableNumber", header: "Table" },
  { accessorKey: "scoresIn", header: "Scores in" },
  { accessorKey: "assigned", header: "Assigned" },
  {
    id: "missing",
    header: "Coverage",
    cell: ({ row }) =>
      row.original.missingScores
        ? <Badge variant="outline">Missing scores</Badge>
        : "Complete",
  },
];
const judgeColumns = [
  { accessorKey: "name", header: "Judge" },
  { accessorKey: "email", header: "Email" },
  { accessorKey: "done", header: "Done" },
  { accessorKey: "total", header: "Total" },
];
function empty() {
  return (
    <EmptyState
      title="No judging records"
      description="Records will appear as projects and assignments are added."
    />
  );
}

/** @param {object} props - Results selects admin ranking mode. @returns {React.ReactNode} Judging report. */
export default function JudgingReports({ results = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState("");
  const [category, setCategory] = useState("all");
  const [mode, setMode] = useState("adjusted");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiFetch(`${root}/${results ? "results" : "progress"}`));
      setError("");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [results]);
  useEffect(() => {
    load();
    if (results) return;
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load, results]);
  async function download(kind) {
    setDownloading(kind);
    try {
      await apiDownload(`${root}/${kind}.csv`, `judging-${kind}.csv`);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloading("");
    }
  }
  const rows = data?.results || [];
  const categories = [...new Set(rows.map((p) => p.category))].sort();
  const categoryName = category === "all" ? null : categories[Number(category)];
  const ranking = rows.filter(
    (p) => category === "all" || p.category === categoryName,
  );
  const scoreKey = `${mode}${category === "all" ? "General" : "Category"}`;
  ranking.sort((a, b) => {
    if (a.withdrawn !== b.withdrawn)
      return Number(a.withdrawn) - Number(b.withdrawn);
    return (b[scoreKey] ?? -Infinity) - (a[scoreKey] ?? -Infinity);
  });
  let previous = null;
  let previousRank = null;
  const ranked = ranking.map((p, i) => {
    const rank =
      p.withdrawn || !p.scoreCount
        ? null
        : p[scoreKey] === previous
          ? previousRank
          : i + 1;
    previous = p[scoreKey];
    previousRank = rank;
    return { ...p, displayRank: rank };
  });
  const resultColumns = [
    { accessorKey: "displayRank", header: "Rank" },
    { accessorKey: "name", header: "Project" },
    { accessorKey: "category", header: "Category" },
    { accessorKey: "scoreCount", header: "Scores" },
    ...["General", "Category"].map((kind) => ({
      accessorKey: `${mode}${kind}`,
      header: `${mode === "raw" ? "Raw" : "Adjusted"} ${kind.toLowerCase()}`,
      cell: ({ getValue }) =>
        getValue() == null ? "No scores" : getValue().toFixed(3),
    })),
    {
      id: "flags",
      header: "Flags",
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1">
          {row.original.flags.missingScores && (
            <Badge variant="outline">Too few scores</Badge>
          )}
          {row.original.flags.noCalibration && (
            <Badge variant="outline">No calibration</Badge>
          )}
          {row.original.withdrawn && <Badge variant="outline">Withdrawn</Badge>}
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" loading={loading} onClick={load}>
          Refresh
        </Button>
        {(results ? ["scores", "results", "progress"] : ["progress"]).map(
          (kind) => (
            <Button
              key={kind}
              variant="outline"
              disabled={!!downloading}
              loading={downloading === kind}
              onClick={() => download(kind)}
            >
              Download {kind} CSV
            </Button>
          ),
        )}
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error} Use Refresh to retry.</AlertDescription>
        </Alert>
      )}
      {results
        ? <>
            <p className="text-sm text-muted-foreground">
              Overall ranks use general totals. Category ranks use category
              totals. Ties share a rank. Withdrawn projects are unranked. Bias
              is subtracted once from each judge's weighted total before
              averaging.
            </p>
            <div className="flex flex-wrap gap-4">
              <div className="space-y-2">
                <Label htmlFor="ranking-category">Ranking</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="ranking-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Overall</SelectItem>
                    {categories.map((name, i) => (
                      <SelectItem key={name} value={String(i)}>
                        {name || "Uncategorized"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ranking-mode">Scores</Label>
                <Select value={mode} onValueChange={setMode}>
                  <SelectTrigger id="ranking-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="adjusted">Bias-adjusted</SelectItem>
                    <SelectItem value="raw">Raw</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DataTable
              columns={resultColumns}
              data={ranked}
              loading={loading}
              emptyState={empty()}
            />
          </>
        : <>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Active version: {data?.activeVersion ?? "None"}.{" "}
              {data?.missingProjects.length ?? 0} projects missing scores.
              Target: {data?.judgingsPerProject ?? 3} scores per project.
              Refreshes every 15 seconds. Counts use active queue pairs.
            </p>
            <h2 className="text-base font-semibold">Project progress</h2>
            <DataTable
              columns={projectColumns}
              data={data?.projects || []}
              loading={loading}
              emptyState={empty()}
            />
            <h2 className="text-base font-semibold">Judge progress</h2>
            <DataTable
              columns={judgeColumns}
              data={data?.judges || []}
              loading={loading}
              emptyState={empty()}
            />
          </>}
    </div>
  );
}
