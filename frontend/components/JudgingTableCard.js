"use client";
import { useCallback, useEffect, useState } from "react";
import QRScanner from "@/components/QRScanner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { loadSiteMeta } from "@/lib/features";

export default function JudgingTableCard() {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    return loadSiteMeta()
      .then((meta) => {
        if (meta.features?.judging === false) return null;
        return apiFetch("/api/judging/projects");
      })
      .then((data) => setProjects(data?.projects || []))
      .catch((err) => {
        if (![403, 404].includes(err.status)) setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function scan(token) {
    setError("");
    setMessage("");
    try {
      const data = await apiFetch("/api/judging/table-checkin", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setProjects((items) =>
        items.map((p) => (p._id === data.project._id ? data.project : p)),
      );
      setMessage("Table check-in complete");
    } catch (err) {
      setError(err.message);
    }
  }
  if (loading) return <Skeleton className="mb-4 h-28 w-full" />;
  if (!projects.length && !error) return null;
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Judging check-in</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {projects.map((p) => (
          <div key={p._id}>
            <p className="font-medium">{p.name}</p>
            <p>
              {p.tableNumber
                ? `Your table: ${p.tableNumber} in ${p.room?.name}`
                : "Check in at the judging desk to get your table."}
            </p>
            {p.tableCheckedInAt && (
              <p className="text-sm text-success">Table check-in complete</p>
            )}
          </div>
        ))}
        <Button
          variant="outline"
          disabled={!projects.length}
          onClick={() => setScanning(!scanning)}
        >
          Scan table QR
        </Button>
        {scanning && <QRScanner onScan={scan} />}
        <div aria-live="polite">
          {message}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>
                {error}{" "}
                <Button size="sm" variant="outline" onClick={load}>
                  Refresh tables
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
