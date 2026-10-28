"use client";

import { useCallback, useEffect, useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { z } from "zod";
import DataTable from "@/components/DataTable";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";
import { notifySuccess } from "@/lib/notify";

const root = "/api/admin/judging";
const schema = z.object({
  calibrationProjects: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().max(5000),
        link: z
          .string()
          .max(2000)
          .refine((v) => !v || /^https:\/\//.test(v), "Use an HTTPS link."),
      }),
    )
    .min(1)
    .max(20),
  criteria: z
    .array(
      z.object({
        key: z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
          .max(60),
        label: z.string().trim().min(1).max(200),
        help: z.string().max(5000),
        min: z.coerce.number().int(),
        max: z.coerce.number().int(),
        weight: z.coerce.number().positive(),
        kind: z.enum(["general", "category"]),
      }),
    )
    .min(2)
    .max(30),
});
function Editor({ settings, onSaved }) {
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: {
      calibrationProjects: settings.calibrationProjects,
      criteria: settings.criteria,
    },
  });
  const projects = useFieldArray({
    control: form.control,
    name: "calibrationProjects",
  });
  const criteria = useFieldArray({ control: form.control, name: "criteria" });
  const locked = settings.judgingOpen || settings.criteriaLocked;
  async function save(values) {
    form.clearErrors("root.server");
    try {
      const result = await apiFetch(`${root}/settings`, {
        method: "PATCH",
        body: JSON.stringify(values),
      });
      notifySuccess("Calibration settings saved");
      onSaved(result.settings);
    } catch (err) {
      applyServerError(form, err);
    }
  }
  function field(path, label, numeric = false) {
    return (
      <FormField
        key={path}
        control={form.control}
        name={path}
        render={({ field: input }) => (
          <FormItem>
            <FormLabel>{label}</FormLabel>
            <FormControl>
              <Input
                {...input}
                type={numeric ? "number" : "text"}
                step={path.endsWith("weight") ? "any" : 1}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    );
  }
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(save)} className="space-y-6">
        <p className="text-sm text-muted-foreground">
          Projects run in the order below. Saving projects or criteria resets
          all calibration scores and bias. Use one category criterion and at
          least one general criterion.
        </p>
        {locked && (
          <Alert>
            <AlertDescription>
              Judging has started. Projects and criteria are locked.
            </AlertDescription>
          </Alert>
        )}
        <fieldset
          disabled={locked || form.formState.isSubmitting}
          className="space-y-6"
        >
          <legend className="text-base font-semibold">Practice projects</legend>
          {projects.fields.map((row, i) => (
            <div key={row.id} className="space-y-4 border-b pb-4">
              <h3 className="text-sm font-medium">Round {i + 1}</h3>
              {field(`calibrationProjects.${i}.title`, "Title")}
              {field(`calibrationProjects.${i}.description`, "Description")}
              {field(`calibrationProjects.${i}.link`, "Link (optional)")}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={i === 0}
                  onClick={() => projects.move(i, i - 1)}
                >
                  Move earlier
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={i === projects.fields.length - 1}
                  onClick={() => projects.move(i, i + 1)}
                >
                  Move later
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={projects.fields.length === 1}
                  onClick={() => projects.remove(i)}
                >
                  Remove round {i + 1}
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={projects.fields.length >= 20}
            onClick={() =>
              projects.append({ title: "", description: "", link: "" })
            }
          >
            Add practice project
          </Button>
          <h2 className="text-base font-semibold">Criteria</h2>
          {criteria.fields.map((row, i) => (
            <div
              key={row.id}
              className="grid gap-4 border-b pb-4 sm:grid-cols-2"
            >
              {field(`criteria.${i}.key`, "Key")}
              {field(`criteria.${i}.label`, "Label")}
              {field(`criteria.${i}.help`, "Guiding questions")}
              {field(`criteria.${i}.min`, "Minimum", true)}
              {field(`criteria.${i}.max`, "Maximum", true)}
              {field(`criteria.${i}.weight`, "Weight", true)}
              <FormField
                control={form.control}
                name={`criteria.${i}.kind`}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kind</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="general">General</SelectItem>
                        <SelectItem value="category">Category</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="button"
                variant="ghost"
                disabled={criteria.fields.length <= 2}
                onClick={() => criteria.remove(i)}
              >
                Remove criterion {i + 1}
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            disabled={criteria.fields.length >= 30}
            onClick={() =>
              criteria.append({
                key: "",
                label: "",
                help: "",
                min: 0,
                max: 10,
                weight: 1,
                kind: "general",
              })
            }
          >
            Add criterion
          </Button>
        </fieldset>
        {form.formState.errors.root?.server && (
          <Alert variant="destructive">
            <AlertDescription>
              {form.formState.errors.root.server.message}
            </AlertDescription>
          </Alert>
        )}
        <Button
          type="submit"
          disabled={locked}
          loading={form.formState.isSubmitting}
        >
          Save calibration settings
        </Button>
      </form>
    </Form>
  );
}
export default function AdminJudgingCalibration() {
  const [settings, setSettings] = useState(null);
  const [judges, setJudges] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [s, b] = await Promise.all([
        apiFetch(`${root}/settings`),
        apiFetch(`${root}/bias`),
      ]);
      setSettings(s.settings);
      setJudges(b.judges);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function compute() {
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch(`${root}/bias`, { method: "POST" });
      setJudges(result.judges);
      notifySuccess("Bias computed");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="outline" onClick={load}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {loading
        ? <Skeleton className="h-64 w-full" />
        : settings && (
            <Editor
              key={settings.updatedAt}
              settings={settings}
              onSaved={() => load()}
            />
          )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-base font-semibold">Judge bias</h2>
        <Button
          variant="outline"
          loading={busy}
          disabled={loading || !settings}
          onClick={compute}
        >
          Compute bias
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Only judges who finished all rounds contribute. Recompute after scores
        change. Positive bias means more generous scoring.
      </p>
      <DataTable
        loading={loading}
        data={judges}
        emptyState="No judges yet"
        columns={[
          { accessorKey: "name", header: "Name" },
          {
            id: "done",
            header: "Calibration",
            cell: ({ row }) => (row.original.done ? "Complete" : "Incomplete"),
          },
          ...["general", "category"].map((kind) => ({
            id: kind,
            header: kind === "general" ? "General bias" : "Category bias",
            cell: ({ row }) =>
              row.original.bias
                ? row.original.bias[kind].toFixed(3)
                : "Not computed",
          })),
        ]}
      />
    </section>
  );
}
