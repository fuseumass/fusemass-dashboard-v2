"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import DataTable from "@/components/DataTable";
import PageHeader from "@/components/PageHeader";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { useFeatures } from "@/lib/features";
import { applyServerError, zodResolver } from "@/lib/forms";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

const schema = z.object({
  name: z.string().trim().min(1, "Enter a name."),
  email: z.email("Enter a valid email."),
  hardware: z.boolean(),
});
const base = "/api/admin/judges";

export default function JudgesPage() {
  const user = useUser();
  const router = useRouter();
  const features = useFeatures();
  const admin = user.role === "admin";
  const [judges, setJudges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState(null);
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", hardware: false },
  });
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setJudges((await apiFetch(base)).judges);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!admin) {
      router.replace("/dashboard");
      return;
    }
    if (features.judging) load();
  }, [admin, router, features.judging, load]);

  async function invite(values) {
    form.clearErrors("root.server");
    try {
      await apiFetch(base, { method: "POST", body: JSON.stringify(values) });
      setOpen(false);
      form.reset();
      notifySuccess("Judge invited");
      await load();
    } catch (err) {
      applyServerError(form, err);
    }
  }
  async function action(path, method, body) {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(base + path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
      });
      await load();
      return data;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function readCsv(event) {
    setPreview(null);
    setCsv("");
    setError("");
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 100000) {
      setError("Upload a CSV smaller than 100 KB.");
      return;
    }
    try {
      setCsv(await file.text());
    } catch {
      setError("Could not read the CSV file.");
    }
  }
  async function previewCsv() {
    setBusy(true);
    setError("");
    try {
      setPreview(
        (
          await apiFetch(`${base}/preview`, {
            method: "POST",
            body: JSON.stringify({ csv }),
          })
        ).rows,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (!admin) return null;
  if (!features.judging)
    return (
      <PageHeader
        title="Judges"
        description="Judging is disabled in settings."
      />
    );
  const columns = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "email", header: "Email" },
    {
      accessorKey: "hardware",
      header: "Hardware",
      cell: ({ row }) => (row.original.hardware ? "Yes" : "No"),
    },
    {
      accessorKey: "inviteStatus",
      header: "Invite status",
      cell: ({ row }) =>
        ({ accepted: "Accepted", pending: "Pending", expired: "Expired" })[
          row.original.inviteStatus
        ],
    },
    {
      accessorKey: "calibrationDone",
      header: "Calibration",
      cell: ({ row }) =>
        row.original.calibrationDone ? "Complete" : "Not started",
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (await action(`/${row.original._id}/resend`, "POST"))
                notifySuccess("Invite resent");
            }}
          >
            Resend invite
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setRemoving(row.original)}
          >
            Remove
          </Button>
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Judges"
        description="Invite judges and track their setup status."
        actions={<Button onClick={() => setOpen(true)}>Invite judge</Button>}
      />
      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
      <DataTable
        columns={columns}
        data={judges}
        loading={loading}
        dense
        getRowId={(row) => row._id}
      />
      <section className="space-y-4" aria-labelledby="bulk-title">
        <h2 id="bulk-title" className="text-base font-semibold">
          Bulk invite
        </h2>
        <p className="text-sm text-muted-foreground">
          Upload a CSV with columns name,email,hardware. Hardware must be true
          or false. Preview sends no emails.
        </p>
        <div className="space-y-2">
          <Label htmlFor="judge-csv">Judges CSV</Label>
          <Input
            id="judge-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={readCsv}
            disabled={busy}
          />
        </div>
        <Button variant="outline" disabled={!csv || busy} onClick={previewCsv}>
          Preview CSV
        </Button>
        {preview
          ? <>
              <DataTable
                data={preview}
                dense
                columns={[
                  { accessorKey: "row", header: "Row" },
                  { accessorKey: "name", header: "Name" },
                  { accessorKey: "email", header: "Email" },
                  {
                    accessorKey: "hardware",
                    header: "Hardware",
                    cell: ({ row }) => (row.original.hardware ? "Yes" : "No"),
                  },
                  {
                    accessorKey: "error",
                    header: "Validation",
                    cell: ({ row }) => row.original.error || "Ready",
                  },
                ]}
              />
              <Button
                loading={busy}
                disabled={preview.some((row) => row.error)}
                onClick={async () => {
                  const data = await action("/bulk", "POST", {
                    csv,
                    confirm: true,
                  });
                  if (data) {
                    const failed = data.results.filter((row) => !row.sent);
                    setPreview(null);
                    setCsv("");
                    if (failed.length)
                      setError(
                        `Invites failed for: ${failed.map((row) => row.email).join(", ")}. Resend from the judges list.`,
                      );
                    else notifySuccess("Invites sent");
                  }
                }}
              >
                Send invites
              </Button>
            </>
          : null}
      </section>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite judge</DialogTitle>
            <DialogDescription>
              The invite link works for seven days. Inviting an existing
              applicant gives them the judge role.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              className="space-y-4"
              noValidate
              onSubmit={form.handleSubmit(invite)}
            >
              {["name", "email"].map((name) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {name === "name" ? "Name" : "Email"}
                      </FormLabel>
                      <FormControl>
                        <Input
                          type={name === "email" ? "email" : "text"}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              <FormField
                control={form.control}
                name="hardware"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(value) =>
                          field.onChange(value === true)
                        }
                      />
                    </FormControl>
                    <FormLabel>Hardware judge</FormLabel>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormRootError />
              <Button type="submit" loading={form.formState.isSubmitting}>
                Send invite
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!value && !busy) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove judge?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.name} will become an applicant and lose judging access
              immediately. Their profile is kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={busy}
              onClick={async () => {
                if (await action(`/${removing._id}`, "DELETE")) {
                  setRemoving(null);
                  notifySuccess("Judge removed");
                }
              }}
            >
              Remove judge
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
