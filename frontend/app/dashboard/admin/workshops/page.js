"use client";

import Link from "next/link";

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
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [organizers, setOrganizers] = useState([]);
  const [email, setEmail] = useState("");
  const [lookup, setLookup] = useState(null);
  const [lookupMessage, setLookupMessage] = useState("");
  const [looking, setLooking] = useState(false);
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
  useEffect(() => {
    setLookup(null);
    setLookupMessage("");
    if (!open || !admin || !email.trim()) {
      setLooking(false);
      return;
    }
    let active = true;
    setLooking(true);
    const timer = setTimeout(async () => {
      try {
        const result = await apiFetch(
          `/api/admin/workshops/organizer-lookup?email=${encodeURIComponent(email.trim())}`,
        );
        if (active) setLookup(result.user);
      } catch (err) {
        if (active) setLookupMessage(err.message);
      } finally {
        if (active) setLooking(false);
      }
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [email, open, admin]);
  if (!admin) return null;
  function edit(item) {
    setEditing(item);
    setOrganizers(item?.organizers || []);
    setEmail("");
    setLookup(null);
    setLookupMessage("");
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
            organizers: organizers.map((person) => person.id || person._id),
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
    {
      accessorKey: "title",
      header: "Title",
      cell: ({ row }) => (
        <Link
          className="text-link underline"
          href={`/dashboard/organize/${row.original._id}`}
        >
          {row.original.title}
        </Link>
      ),
    },
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
                ["host", "Host name"],
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
                      {name === "host" && (
                        <FormDescription>
                          Shown to attendees, e.g. Jane Doe or the club name.
                        </FormDescription>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              <div className="space-y-2">
                <Label htmlFor="organizer-email">Organizers</Label>
                <p className="text-xs text-muted-foreground">
                  Add up to 10 people by their account email.
                </p>
                <div className="flex flex-wrap gap-2">
                  {organizers.map((person) => (
                    <Badge
                      key={person.id || person._id}
                      variant="secondary"
                      className="max-w-full whitespace-normal break-all"
                    >
                      {person.name} ({person.email})
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove ${person.name}`}
                        disabled={form.formState.isSubmitting}
                        onClick={() =>
                          setOrganizers((people) =>
                            people.filter((entry) => entry !== person),
                          )
                        }
                      >
                        Remove
                      </Button>
                    </Badge>
                  ))}
                </div>
                <Input
                  id="organizer-email"
                  type="email"
                  value={email}
                  disabled={
                    organizers.length >= 10 || form.formState.isSubmitting
                  }
                  onChange={(event) => {
                    setEmail(event.target.value);
                    setLookup(null);
                  }}
                />
                <div aria-live="polite" className="text-sm">
                  {looking && (
                    <p className="text-muted-foreground">
                      Looking up account...
                    </p>
                  )}
                  {lookupMessage && (
                    <p className="text-destructive">{lookupMessage}</p>
                  )}
                  {lookup && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        organizers.length >= 10 ||
                        form.formState.isSubmitting ||
                        organizers.some(
                          (person) => (person.id || person._id) === lookup.id,
                        )
                      }
                      onClick={() => {
                        if (
                          organizers.length === 0 &&
                          !form.getValues("host").trim()
                        )
                          form.setValue("host", lookup.name);
                        setOrganizers((people) => [...people, lookup]);
                        setEmail("");
                        setLookup(null);
                      }}
                    >
                      Add {lookup.name} ({lookup.email})
                    </Button>
                  )}
                </div>
              </div>
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
