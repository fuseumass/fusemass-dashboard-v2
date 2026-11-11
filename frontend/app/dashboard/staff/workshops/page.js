"use client";

import { MoreHorizontal } from "lucide-react";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiDownload, apiFetch } from "@/lib/api";
import { formatDateTime, formatRange } from "@/lib/datetime";
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
  // Moderators and admins manage workshops and their organizers.
  const staff = user.role === "moderator" || user.role === "admin";
  const [organizers, setOrganizers] = useState([]);
  const [email, setEmail] = useState("");
  const [lookup, setLookup] = useState(null);
  const [lookupMessage, setLookupMessage] = useState("");
  const [looking, setLooking] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [saveConfirmation, setSaveConfirmation] = useState(null);
  const [savingConfirmed, setSavingConfirmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [attention, setAttention] = useState(false);
  const [selected, setSelected] = useState([]);
  const [publishing, setPublishing] = useState(null);
  const [signupWorkshop, setSignupWorkshop] = useState(null);
  const [signupSearch, setSignupSearch] = useState("");
  const [signups, setSignups] = useState([]);
  const [signupLoading, setSignupLoading] = useState(false);
  const [signupError, setSignupError] = useState("");
  const [downloading, setDownloading] = useState(false);
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
    if (!staff) router.replace("/dashboard");
    else load();
  }, [staff, router, load]);
  useEffect(() => {
    setLookup(null);
    setLookupMessage("");
    if (!open || !staff || !email.trim()) {
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
  }, [email, open, staff]);
  useEffect(() => {
    if (!signupWorkshop || !staff) return;
    let active = true;
    setSignupLoading(true);
    setSignupError("");
    setSignups([]);
    apiFetch(`/api/admin/workshops/${signupWorkshop._id}/signups`)
      .then((data) => {
        if (active) setSignups(data.signups);
      })
      .catch((err) => {
        if (active) setSignupError(err.message);
      })
      .finally(() => {
        if (active) setSignupLoading(false);
      });
    return () => {
      active = false;
    };
  }, [signupWorkshop, staff]);
  if (!staff) return null;
  const needsRoom = (item) => !item.location?.trim();
  const needsOrganizers = (item) => !item.organizers?.length;
  const itemStatus = (item) =>
    item.cancelled ? "cancelled" : item.published ? "published" : "draft";
  const filtered = items.filter(
    (item) =>
      [item.title, item.host, item.location].some((value) =>
        (value || "").toLowerCase().includes(search.toLowerCase()),
      ) &&
      (status === "all" || itemStatus(item) === status) &&
      (!attention ||
        needsRoom(item) ||
        needsOrganizers(item) ||
        itemStatus(item) === "draft"),
  );
  const publishable = items.filter(
    (item) => selected.includes(item._id) && !item.cancelled && !item.published,
  );
  async function publish(rows, published) {
    setPending(true);
    setError("");
    const results = await Promise.allSettled(
      rows.map((item) =>
        apiFetch(`/api/admin/workshops/${item._id}`, {
          method: "PATCH",
          body: JSON.stringify({ published }),
        }),
      ),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${rows[index].title}: ${result.reason.message}`]
        : [],
    );
    const succeeded = rows
      .filter((_, index) => results[index].status === "fulfilled")
      .map((item) => item._id);
    setSelected((ids) => ids.filter((id) => !succeeded.includes(id)));
    setPublishing(null);
    await load();
    if (failures.length) setError(failures.join("; "));
    if (succeeded.length)
      notifySuccess(
        `${succeeded.length} workshops ${published ? "published" : "unpublished"}`,
      );
    setPending(false);
  }
  async function downloadSignups() {
    setDownloading(true);
    try {
      await apiDownload(
        `/api/admin/workshops/${signupWorkshop._id}/signups.csv`,
        "workshop-signups.csv",
      );
      notifySuccess("Sign-ups downloaded");
    } catch (err) {
      setSignupError(err.message);
    } finally {
      setDownloading(false);
    }
  }
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
  async function save(values, confirmed = false) {
    if (values.published && !values.location.trim() && confirmed !== true) {
      setSaveConfirmation(values);
      return;
    }
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
      id: "select",
      enableSorting: false,
      header: () => (
        <Checkbox
          aria-label="Select filtered drafts"
          disabled={pending}
          checked={
            filtered.some((item) => !item.cancelled && !item.published) &&
            filtered
              .filter((item) => !item.cancelled && !item.published)
              .every((item) => selected.includes(item._id))
          }
          onCheckedChange={(checked) =>
            setSelected((ids) =>
              checked
                ? [
                    ...new Set([
                      ...ids,
                      ...filtered
                        .filter((item) => !item.cancelled && !item.published)
                        .map((item) => item._id),
                    ]),
                  ]
                : ids.filter((id) => !filtered.some((item) => item._id === id)),
            )
          }
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Select ${row.original.title}`}
          disabled={pending || row.original.cancelled || row.original.published}
          checked={selected.includes(row.original._id)}
          onCheckedChange={(checked) =>
            setSelected((ids) =>
              checked
                ? [...ids, row.original._id]
                : ids.filter((id) => id !== row.original._id),
            )
          }
        />
      ),
    },
    {
      accessorKey: "title",
      header: "Workshop",
      meta: { className: "min-w-48 max-w-72 whitespace-normal" },
      cell: ({ row }) => (
        <div className="space-y-1">
          <Link
            className="text-link underline"
            href={`/dashboard/organize/${row.original._id}`}
          >
            {row.original.title}
          </Link>
          <p className="text-xs text-muted-foreground">
            {row.original.host ? `Host: ${row.original.host}` : "Host not set"}
          </p>
        </div>
      ),
    },
    {
      accessorKey: "startsAt",
      header: "When and where",
      meta: { className: "min-w-40 whitespace-normal" },
      cell: ({ row }) => (
        <div className="space-y-1">
          <p>{formatRange(row.original.startsAt, row.original.endsAt)}</p>
          {needsRoom(row.original)
            ? <Badge variant="warning">Room needed</Badge>
            : <p className="text-xs text-muted-foreground">
                {row.original.location}
              </p>}
        </div>
      ),
    },
    {
      id: "organizers",
      header: "Organizers",
      meta: { className: "min-w-28 max-w-48 whitespace-normal" },
      cell: ({ row }) =>
        needsOrganizers(row.original)
          ? <Badge variant="warning">None yet</Badge>
          : row.original.organizers.map((person) => person.name).join(", "),
    },
    {
      id: "capacity",
      header: "Sign-ups",
      cell: ({ row }) => (
        <span>
          {row.original.signupCount} / {row.original.capacity || "unlimited"}
          <span className="block text-xs text-muted-foreground">
            {row.original.attendedCount} attended
          </span>
        </span>
      ),
    },
    {
      id: "raffle",
      header: "Raffle",
      cell: ({ row }) =>
        row.original.raffleEnabled
          ? <span>
              On{" "}
              <span className="block text-xs text-muted-foreground">
                {row.original.winnerCount} winners, {row.original.claimedCount}{" "}
                claimed
              </span>
            </span>
          : "Off",
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.cancelled
              ? "destructive"
              : row.original.published
                ? "success"
                : "secondary"
          }
        >
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
            disabled={pending || row.original.cancelled}
            onClick={() => edit(row.original)}
          >
            Edit
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${row.original.title}`}
                disabled={pending}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem
                disabled={row.original.cancelled}
                onSelect={() =>
                  row.original.published
                    ? publish([row.original], false)
                    : needsRoom(row.original)
                      ? setPublishing([row.original])
                      : publish([row.original], true)
                }
              >
                {row.original.published ? "Unpublish" : "Publish"}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setSignupSearch("");
                  setSignupWorkshop(row.original);
                }}
              >
                View sign-ups
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/dashboard/organize/${row.original._id}`}>
                  Open console
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={row.original.cancelled}
                onSelect={() => setCancelling(row.original)}
              >
                Cancel workshop
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];
  return (
    <div className="min-w-0 space-y-6">
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
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {items.length} workshops:{" "}
        {items.filter((item) => itemStatus(item) === "draft").length} drafts,{" "}
        {items.filter(needsOrganizers).length} without organizers,{" "}
        {items.filter(needsRoom).length} without a room
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor="workshop-search">Search workshops</Label>
          <Input
            id="workshop-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, host or location"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="workshop-status">Status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="workshop-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["all", "draft", "published", "cancelled"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Label className="flex items-center gap-2">
          <Checkbox checked={attention} onCheckedChange={setAttention} />
          Needs attention
        </Label>
        <Button
          variant="outline"
          disabled={pending || !publishable.length}
          onClick={() => setPublishing(publishable)}
        >
          Publish selected ({publishable.length})
        </Button>
      </div>
      <DataTable
        className="min-w-0 max-w-full"
        dense
        columns={columns}
        data={filtered}
        loading={loading}
        emptyState={
          <EmptyState
            title={items.length ? "No matching workshops" : "No workshops yet"}
            description={
              items.length
                ? "Adjust your search or filters."
                : "Create a workshop to open signups."
            }
          />
        }
      />
      <AlertDialog
        open={Boolean(saveConfirmation)}
        onOpenChange={(value) => {
          if (!value && !savingConfirmed) setSaveConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish without a room?</AlertDialogTitle>
            <AlertDialogDescription>
              {saveConfirmation?.title} has no room. Attendees will see this
              workshop without a location.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={savingConfirmed}>
              Return to editor
            </AlertDialogCancel>
            <Button
              loading={savingConfirmed}
              onClick={async () => {
                setSavingConfirmed(true);
                await save(saveConfirmation, true);
                setSavingConfirmed(false);
                setSaveConfirmation(null);
              }}
            >
              Save and publish
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={Boolean(publishing)}
        onOpenChange={(value) => {
          if (!value && !pending) setPublishing(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Publish {publishing?.length} workshops?
            </AlertDialogTitle>
            <AlertDialogDescription>
              These workshops will be visible to attendees. Review missing rooms
              and organizers before publishing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-60 overflow-y-auto text-sm">
            {publishing
              ?.filter((item) => needsRoom(item) || needsOrganizers(item))
              .map((item) => (
                <li key={item._id}>
                  {item.title}:{" "}
                  {[
                    needsRoom(item) && "room needed",
                    needsOrganizers(item) && "no organizers",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </li>
              ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              Keep drafts
            </AlertDialogCancel>
            <Button loading={pending} onClick={() => publish(publishing, true)}>
              Publish workshops
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={Boolean(signupWorkshop)}
        onOpenChange={(value) => {
          if (!value) setSignupWorkshop(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Sign-ups: {signupWorkshop?.title}</DialogTitle>
            <DialogDescription>
              People signed up and their workshop attendance.
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="signup-search">Search people</Label>
          <Input
            id="signup-search"
            value={signupSearch}
            onChange={(event) => setSignupSearch(event.target.value)}
          />
          {signupError && (
            <Alert variant="destructive">
              <AlertDescription>
                {signupError}{" "}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSignupWorkshop({ ...signupWorkshop })}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <p className="text-sm" aria-live="polite">
            {signupLoading
              ? "Loading sign-ups..."
              : `${signups.length} signed up, ${signups.filter((person) => person.attended).length} attended`}
          </p>
          <Button
            variant="outline"
            loading={downloading}
            onClick={downloadSignups}
          >
            Download CSV
          </Button>
          <DataTable
            loading={signupLoading}
            data={signups.filter((person) =>
              `${person.name} ${person.email}`
                .toLowerCase()
                .includes(signupSearch.toLowerCase()),
            )}
            columns={[
              { accessorKey: "name", header: "Name" },
              { accessorKey: "email", header: "Email" },
              {
                accessorKey: "signedUpAt",
                header: "Signed up",
                cell: ({ row }) => formatDateTime(row.original.signedUpAt),
              },
              {
                accessorKey: "attended",
                header: "Attended",
                cell: ({ row }) => (row.original.attended ? "Yes" : "No"),
              },
            ]}
            emptyState={
              <p className="p-4 text-sm text-muted-foreground">
                No matching sign-ups.
              </p>
            }
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!form.formState.isSubmitting && !savingConfirmed) setOpen(value);
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
