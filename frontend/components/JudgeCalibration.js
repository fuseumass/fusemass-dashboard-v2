"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";
import { notifySuccess } from "@/lib/notify";

function RoundForm({ data, round, onSaved }) {
  const project = data.rounds[round - 1];
  const saved = data.scores.find((row) => row.round === round);
  const shape = Object.fromEntries(
    data.criteria.map((c) => [
      c.key,
      z.coerce.number().int().min(c.min).max(c.max),
    ]),
  );
  const form = useForm({
    resolver: zodResolver(
      z.object({ scores: z.object(shape), comments: z.string().max(5000) }),
    ),
    defaultValues: {
      scores: Object.fromEntries(
        data.criteria.map((c) => [c.key, saved?.scores[c.key] ?? c.min]),
      ),
      comments: saved?.comments || "",
    },
  });
  async function save(values) {
    form.clearErrors("root.server");
    try {
      const result = await apiFetch(`/api/judging/calibration/${round}`, {
        method: "POST",
        body: JSON.stringify(values),
      });
      notifySuccess("Round saved");
      onSaved(result);
    } catch (err) {
      applyServerError(form, err);
    }
  }
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(save)} className="space-y-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Round {round} of {data.rounds.length}
          </p>
          <h2 className="text-base font-semibold">{project.title}</h2>
          {project.description && (
            <p className="whitespace-pre-wrap text-sm">{project.description}</p>
          )}
          {project.link && (
            <a
              className="text-sm text-link underline"
              href={project.link}
              target="_blank"
              rel="noreferrer"
            >
              Open practice project
            </a>
          )}
        </div>
        {data.criteria.map((c) => (
          <FormField
            key={c.key}
            control={form.control}
            name={`scores.${c.key}`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {c.label} ({c.min} to {c.max})
                </FormLabel>
                <p
                  id={`help-${c.key}`}
                  className="text-sm text-muted-foreground"
                >
                  {c.help}
                </p>
                <FormControl>
                  <Input
                    {...field}
                    aria-describedby={`help-${c.key}`}
                    type="number"
                    min={c.min}
                    max={c.max}
                    step={1}
                    required
                    className="max-w-32"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <FormField
          control={form.control}
          name="comments"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Comments</FormLabel>
              <FormControl>
                <Textarea {...field} maxLength={5000} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {form.formState.errors.root?.server && (
          <Alert variant="destructive">
            <AlertDescription>
              {form.formState.errors.root.server.message}
            </AlertDescription>
          </Alert>
        )}
        <Button type="submit" loading={form.formState.isSubmitting}>
          Save round
        </Button>
      </form>
    </Form>
  );
}

export default function JudgeCalibration() {
  const [data, setData] = useState(null);
  const [round, setRound] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await apiFetch("/api/judging/calibration");
      setData({
        ...result,
        rounds: result.rounds.map((project, index) => ({
          ...project,
          round: index + 1,
        })),
      });
      setRound(Math.min(result.scores.length + 1, result.rounds.length));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error}{" "}
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!data?.rounds.length)
    return (
      <p className="text-sm text-muted-foreground">
        Organizers have not configured calibration projects.
      </p>
    );
  return (
    <section className="max-w-2xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Everyone scores the same practice projects so we can correct for strict
        and generous judges.
      </p>
      {data.calibrationDone && (
        <Alert>
          <AlertDescription>
            Calibration done. Judging assignments will be available when
            organizers start judging. You can edit your earlier rounds below.
          </AlertDescription>
        </Alert>
      )}
      <nav aria-label="Calibration rounds" className="flex flex-wrap gap-2">
        {data.rounds.map((project, i) => (
          <Button
            key={project.round}
            variant={round === i + 1 ? "default" : "outline"}
            disabled={i > data.scores.length}
            aria-current={round === i + 1 ? "step" : undefined}
            onClick={() => setRound(i + 1)}
          >
            Round {i + 1}
          </Button>
        ))}
      </nav>
      <div aria-live="polite">
        <RoundForm
          key={`${round}-${data.scores.length}`}
          data={data}
          round={round}
          onSaved={(result) => {
            setData({ ...data, ...result });
            if (round < data.rounds.length) setRound(round + 1);
          }}
        />
      </div>
    </section>
  );
}
