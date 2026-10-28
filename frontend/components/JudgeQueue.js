"use client";

import { useCallback, useEffect, useState } from "react";
import EmptyState from "@/components/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";

function Countdown({ minutes, identity }) {
  const [remaining, setRemaining] = useState(Math.round(minutes * 60));
  useEffect(() => {
    const key = `judging-timer:${identity}`;
    let end = Number(sessionStorage.getItem(key));
    if (!end) {
      end = Date.now() + minutes * 60000;
      sessionStorage.setItem(key, String(end));
    }
    const tick = () =>
      setRemaining(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [minutes, identity]);
  return (
    <p className="text-sm tabular-nums" role="timer">
      Slot countdown: {Math.floor(remaining / 60)}:
      {String(remaining % 60).padStart(2, "0")}.{" "}
      {remaining === 0 && "Time elapsed. You can still save your score."}
    </p>
  );
}

function Rubric({ project, criteria, userId, disabled, busy, onSave }) {
  const key = `judging-draft:${userId}:${project._id}`;
  const [values, setValues] = useState(project.scores || {});
  const [comments, setComments] = useState(project.comments || "");
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      if (saved) {
        setValues(saved.scores || {});
        setComments(saved.comments || "");
      }
    } catch {
      /* Storage may be unavailable. The form still works. */
    }
  }, [key]);
  function change(scores, text) {
    setValues(scores);
    setComments(text);
    try {
      localStorage.setItem(key, JSON.stringify({ scores, comments: text }));
    } catch {
      /* Keep the in-memory form. */
    }
  }
  const complete = criteria.every((c) => Number.isInteger(values[c.key]));
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          await onSave({ projectId: project._id, scores: values, comments })
        ) {
          try {
            localStorage.removeItem(key);
          } catch {
            /* Nothing else to clear. */
          }
        }
      }}
    >
      {criteria.map((c) => (
        <fieldset key={c.key} disabled={disabled || busy} className="space-y-2">
          <legend className="text-sm font-medium">{c.label}</legend>
          <p id={`help-${c.key}`} className="text-xs text-muted-foreground">
            {c.help}
          </p>
          <div
            className="flex flex-wrap gap-2"
            aria-describedby={`help-${c.key}`}
          >
            {Array.from({ length: c.max - c.min + 1 }, (_, n) => n + c.min).map(
              (n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={values[c.key] === n ? "default" : "outline"}
                  aria-label={`${c.label}: ${n}`}
                  aria-pressed={values[c.key] === n}
                  onClick={() => change({ ...values, [c.key]: n }, comments)}
                >
                  {n}
                </Button>
              ),
            )}
          </div>
        </fieldset>
      ))}
      <div className="space-y-2">
        <Label htmlFor="judging-comments">Comments</Label>
        <Textarea
          id="judging-comments"
          maxLength={10000}
          value={comments}
          disabled={disabled || busy}
          onChange={(e) => change(values, e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Unsent changes are saved on this device. If the connection drops, retry
        saving when you reconnect.
      </p>
      <Button
        type="submit"
        loading={busy}
        disabled={disabled || busy || !complete}
      >
        Save score and continue
      </Button>
    </form>
  );
}

export default function JudgeQueue({ userId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try {
      const result = await apiFetch("/api/judging/queue");
      setData(result);
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function action(path, body) {
    if (busy) return false;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await apiFetch(`/api/judging/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSelected(null);
      setMessage(path === "skip" ? "Project skipped" : "Score saved");
      await load();
      return true;
    } catch (err) {
      if (err.status === 409) await load();
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const project =
    data?.assignments.find((p) => p._id === selected) || data?.current;
  function list(items, empty) {
    return items.length
      ? <ul className="space-y-2">
          {items.map((p) => (
            <li
              key={p._id}
              className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm"
            >
              <span>
                {p.position}. {p.name} · Table {p.tableNumber}, {p.room?.name} ·{" "}
                {p.status}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || p.status === "upcoming"}
                onClick={() => setSelected(p._id)}
              >
                {p.status === "done" ? "Rescore" : "Score"}
                <span className="sr-only"> {p.name}</span>
              </Button>
            </li>
          ))}
        </ul>
      : <p className="text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
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
          {!data.judgingOpen && (
            <Alert>
              <AlertDescription>
                Judging is closed. Scores and skips are frozen.
              </AlertDescription>
            </Alert>
          )}
          {!data.version && (
            <EmptyState
              title="No active assignments"
              description="Organizers will activate your queue when it is ready."
            />
          )}
          {data.version && !project && (
            <EmptyState
              title={
                data.skipped.length
                  ? "No upcoming projects"
                  : "All done, thank you"
              }
              description={
                data.skipped.length
                  ? "Return to your skipped projects below."
                  : "Your scores are saved. You can review them below."
              }
            />
          )}
          {project && (
            <Card>
              <CardHeader>
                <p className="text-2xl font-semibold tabular-nums">
                  Table {project.tableNumber} · {project.room?.name}
                </p>
                <CardTitle>{project.name}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {project.category || "No category"} · {project.position} of{" "}
                  {data.total} · Slot {project.slot}
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
                <Rubric
                  key={project._id}
                  project={project}
                  criteria={data.criteria}
                  userId={userId}
                  disabled={!data.judgingOpen}
                  busy={busy}
                  onSave={(body) => action("scores", body)}
                />
                <div className="flex gap-2">
                  {data.current?._id === project._id && (
                    <Button
                      variant="outline"
                      disabled={!data.judgingOpen || busy}
                      loading={busy}
                      onClick={() => action("skip", { projectId: project._id })}
                    >
                      Skip project
                    </Button>
                  )}
                  {selected && (
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setSelected(null)}
                    >
                      Return to current project
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Skipped</h2>
            {list(data.skipped, "No skipped projects")}
          </section>
          <section className="space-y-2">
            <h2 className="text-base font-semibold">Done</h2>
            {list(data.done, "No scores yet")}
          </section>
          <section className="space-y-2">
            <h2 className="text-base font-semibold">My assignments</h2>
            {list(data.assignments, "Your queue is empty")}
          </section>
        </>
      )}
    </div>
  );
}
