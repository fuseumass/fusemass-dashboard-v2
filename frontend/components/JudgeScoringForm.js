"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
export function Countdown({ minutes, identity }) {
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

export default function JudgeScoringForm({
  project,
  criteria,
  userId,
  disabled,
  busy,
  onSave,
}) {
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
