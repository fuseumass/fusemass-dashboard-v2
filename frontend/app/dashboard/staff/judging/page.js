"use client";
import { useState } from "react";
import CheckInStation from "@/components/CheckInStation";
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
  if (!["admin", "moderator"].includes(user.role)) return null;
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
          <p className="text-4xl font-semibold tabular-nums">
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
    </div>
  );
}
