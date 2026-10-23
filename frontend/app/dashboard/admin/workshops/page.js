"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
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
import { Badge } from "@/components/ui/badge";
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
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { formatRange } from "@/lib/datetime";
import { applyServerError, zodResolver } from "@/lib/forms";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

const defaults = {
  title: "",
  host: "",
  description: "",
  location: "",
  startsAt: "",
  endsAt: "",
  capacity: 0,
  published: false,
  raffleEnabled: false,
};
const schema = z
  .object({
    title: z.string().trim().min(1, "Enter a title."),
    host: z.string(),
    description: z.string(),
    location: z.string(),
    startsAt: z.string().min(1, "Enter a start time."),
    endsAt: z.string().min(1, "Enter an end time."),
    capacity: z.coerce.number().int().min(0),
    published: z.boolean(),
    raffleEnabled: z.boolean(),
  })
  .refine((data) => new Date(data.endsAt) > new Date(data.startsAt), {
    path: ["endsAt"],
    message: "End time must be after start time.",
  });
function localInput(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

export default function WorkshopsAdminPage() {
  const user = useUser();
  const router = useRouter();
  const admin = user.role === "admin";
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [pending, setPending] = useState(false);
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      setItems((await apiFetch("/api/admin/workshops")).workshops);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!admin) router.replace("/dashboard");
    else load();
  }, [admin, router, load]);
  if (!admin) return null;
  function edit(item) {
    setEditing(item);
    form.reset(
      item
        ? {
            ...defaults,
            ...item,
            startsAt: localInput(item.startsAt),
            endsAt: localInput(item.endsAt),
          }
        : defaults,
    );
    setOpen(true);
  }
  async function save(values) {
    form.clearErrors("root.server");
    try {
      await apiFetch(
        `/api/admin/workshops${editing ? `/${editing._id}` : ""}`,
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            ...values,
            startsAt: new Date(values.startsAt).toISOString(),
            endsAt: new Date(values.endsAt).toISOString(),
          }),
        },
      );
      setOpen(false);
      notifySuccess(editing ? "Workshop updated" : "Workshop created");
      await load();
    } catch (err) {
      applyServerError(form, err);
    }
  }
  async function cancel() {
    setPending(true);
    try {
      await apiFetch(`/api/admin/workshops/${cancelling._id}`, {
        method: "DELETE",
      });
      setCancelling(null);
      notifySuccess("Workshop cancelled");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending(false);
    }
  }
  const columns = [
    { accessorKey: "title", header: "Title" },
    {
      accessorKey: "startsAt",
      header: "Time",
      cell: ({ row }) =>
        formatRange(row.original.startsAt, row.original.endsAt),
    },
    { accessorKey: "location", header: "Location" },
    {
      id: "capacity",
      header: "Signups / capacity",
      cell: ({ row }) =>
        `${row.original.signupCount} / ${row.original.capacity || "Unlimited"}`,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.cancelled
            ? "Cancelled"
            : row.original.published
              ? "Published"
              : "Draft"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={row.original.cancelled}
            onClick={() => edit(row.original)}
          >
            Edit
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={row.original.cancelled}
            onClick={() => setCancelling(row.original)}
          >
            Cancel workshop
          </Button>
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-6">
      <PageHeader
        title="Workshops"
        actions={<Button onClick={() => edit(null)}>Create workshop</Button>}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <DataTable
        columns={columns}
        data={items}
        loading={loading}
        emptyState={
          <EmptyState
            title="No workshops yet"
            description="Create a workshop to open signups."
          />
        }
      />
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!form.formState.isSubmitting) setOpen(value);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit workshop" : "Create workshop"}
            </DialogTitle>
            <DialogDescription>
              Times use your local time zone. Capacity 0 means unlimited.
              Changes to time or location email everyone signed up.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(save)}
              className="space-y-4"
              noValidate
            >
              {[
                ["title", "Title"],
                ["host", "Host"],
                ["location", "Location"],
                ["startsAt", "Starts", "datetime-local"],
                ["endsAt", "Ends", "datetime-local"],
                ["capacity", "Capacity", "number"],
                ["description", "Description"],
              ].map(([name, label, type]) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{label}</FormLabel>
                      <FormControl>
                        {name === "description"
                          ? <Textarea {...field} />
                          : <Input {...field} type={type || "text"} />}
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              {[
                ["published", "Published"],
                ["raffleEnabled", "Raffle enabled"],
              ].map(([name, label]) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem className="flex items-center gap-2">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <FormLabel>{label}</FormLabel>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              {form.formState.errors.root?.server && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {form.formState.errors.root.server.message}
                  </AlertDescription>
                </Alert>
              )}
              <Button type="submit" loading={form.formState.isSubmitting}>
                Save workshop
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(cancelling)}
        onOpenChange={(value) => {
          if (!value && !pending) setCancelling(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {cancelling?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling?.signupCount || 0} people will be emailed a calendar
              cancellation. Workshops without signups will be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              Keep workshop
            </AlertDialogCancel>
            <Button variant="destructive" loading={pending} onClick={cancel}>
              Cancel workshop
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
