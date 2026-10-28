"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import JudgeSchedule from "@/components/JudgeSchedule";
import JudgeScoringForm, { Countdown } from "@/components/JudgeScoringForm";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import useJudgeQueue from "@/lib/useJudgeQueue";

export default function JudgeQueue({ userId, view = "schedule" }) {
  const { data, error, busy, message, load, action } = useJudgeQueue();
  const params = useSearchParams();
  const router = useRouter();
  const selected = params.get("project");
  const project = selected
    ? data?.assignments.find((p) => p._id === selected)
    : data?.current;
  const reason = !data
    ? ""
    : !data.judgingOpen
      ? data.judgingOpenedAt
        ? "Judging is closed. Scores and skips are frozen."
        : "Judging is not open yet."
      : !data.version || !data.total
        ? "No assignments yet. Organizers will activate your schedule when it is ready."
        : !data.current
          ? data.skipped.length
            ? "Your schedule is complete apart from skipped projects. Return to them from Skipped."
            : "All done. Your scores are saved."
          : "";
  // Calibration is recommended, not required: judges who skip it are flagged
  // in results (B24d), so it never blocks finding a table or scoring.
  const calibrationNote =
    data && !data.calibrationDone
      ? "Score the practice projects in Demo first, so your scores can be calibrated."
      : "";
  async function save(body) {
    const saved = await action("scores", body);
    if (saved) router.replace("/dashboard/judging/score");
    return saved;
  }
  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <p className="text-sm" aria-live="polite">
        {message}
      </p>
      {!data && !error && <Skeleton className="h-64 w-full" />}
      {data && (
        <>
          {calibrationNote && view !== "demo" && (
            <Alert>
              <AlertDescription>
                {calibrationNote}{" "}
                <Link href="/dashboard/judging/demo" className="text-link">
                  Open Demo
                </Link>
              </AlertDescription>
            </Alert>
          )}
          {reason && view !== "schedule" && (
            <Alert>
              <AlertDescription>{reason}</AlertDescription>
            </Alert>
          )}
          {view === "schedule" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-2xl tabular-nums">
                    {!reason && data.current
                      ? `Go to table ${data.current.tableNumber} in ${data.current.room?.name}`
                      : "Your next table"}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!reason && data.current
                    ? <>
                        <p>{data.current.name}</p>
                        <Button asChild>
                          <Link href="/dashboard/judging/score">Judge now</Link>
                        </Button>
                      </>
                    : <p className="text-sm text-muted-foreground">{reason}</p>}
                </CardContent>
              </Card>
              <section className="space-y-2">
                <h2 className="text-base font-semibold">Your schedule</h2>
                {data.slotMinutes && data.judgingOpenedAt && (
                  <p className="text-sm text-muted-foreground">
                    Times are estimates from the first opening of judging.
                  </p>
                )}
                <JudgeSchedule data={data} />
              </section>
            </>
          )}
          {view === "skipped" && <JudgeSchedule data={data} skippedOnly />}
          {view === "score" && (
            <>
              {selected && !project && (
                <Alert>
                  <AlertDescription>
                    This project is no longer in your assignments.
                  </AlertDescription>
                </Alert>
              )}
              {project && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-2xl tabular-nums">
                      Table {project.tableNumber} in {project.room?.name}
                    </CardTitle>
                    <p className="font-medium">{project.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {project.category || "No category"} · {project.position}{" "}
                      of {data.total} · Slot {project.slot}
                    </p>
                    <a
                      href={project.devpostUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-link"
                    >
                      View Devpost project
                    </a>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {data.slotMinutes && (
                      <Countdown
                        key={`${data.version}:${project._id}`}
                        minutes={data.slotMinutes}
                        identity={`${userId}:${data.version}:${project._id}`}
                      />
                    )}
                    {project.status === "upcoming" && (
                      <p className="text-sm text-muted-foreground">
                        Score the current project before this table.
                      </p>
                    )}
                    <JudgeScoringForm
                      key={project._id}
                      project={project}
                      criteria={data.criteria}
                      userId={userId}
                      disabled={
                        !data.judgingOpen || project.status === "upcoming"
                      }
                      busy={busy}
                      onSave={save}
                    />
                    <div className="flex flex-wrap gap-2">
                      {data.current?._id === project._id && (
                        <Button
                          variant="outline"
                          disabled={!data.judgingOpen || busy}
                          loading={busy}
                          onClick={async () => {
                            if (
                              await action("skip", { projectId: project._id })
                            )
                              router.replace("/dashboard/judging/score");
                          }}
                        >
                          Skip project
                        </Button>
                      )}
                      {selected && (
                        <Button asChild variant="ghost" disabled={busy}>
                          <Link href="/dashboard/judging/score">
                            Return to current project
                          </Link>
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
