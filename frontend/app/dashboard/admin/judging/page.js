"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import AdminJudgingCalibration from "@/components/AdminJudgingCalibration";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch, apiUpload } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

const root = "/api/admin/judging";
const roomDefaults = { name: "", order: 0, capacity: 0, hardware: false };
const projectDefaults = {
  category: "",
  hardware: false,
  needsPower: false,
  withdrawn: false,
};
const roomSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(100),
  order: z.coerce.number().int().min(0),
  capacity: z.coerce.number().int().min(0),
  hardware: z.boolean(),
});
const projectSchema = z.object({
  category: z.string(),
  hardware: z.boolean(),
  needsPower: z.boolean(),
  withdrawn: z.boolean(),
});

function Fields({ form, room }) {
  const fields = room
    ? ["name", "order", "capacity", "hardware"]
    : ["category", "hardware", "needsPower", "withdrawn"];
  const labels = {
    name: "Name",
    order: "Order",
    capacity: "Capacity",
    hardware: "Hardware",
    category: "Category",
    needsPower: "Needs power",
    withdrawn: "Withdrawn",
  };
  return fields.map((name) => (
    <FormField
      key={name}
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{labels[name]}</FormLabel>
          <FormControl>
            {["hardware", "needsPower", "withdrawn"].includes(name)
              ? <Checkbox
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              : <Input
                  {...field}
                  type={
                    ["order", "capacity"].includes(name) ? "number" : "text"
                  }
                  min={0}
                />}
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  ));
}
function Filter({ label, value, onChange, options }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={label} className="w-full sm:w-44">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
function unmatched(project) {
  return (
    (project.unmatchedMembers || []).map((member) => member.email).join(", ") ||
    "None"
  );
}
export default function JudgingAdminPage() {
  const user = useUser();
  const router = useRouter();
  const admin = user.role === "admin";
  const [rooms, setRooms] = useState([]);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [filters, setFilters] = useState({
    room: "all",
    hardware: "all",
    category: "",
    unmatchedMembers: "all",
  });
  const form = useForm({
    resolver: zodResolver(
      editing?.kind === "project" ? projectSchema : roomSchema,
    ),
    defaultValues: roomDefaults,
  });
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [r, p] = await Promise.all([
        apiFetch(`${root}/rooms`),
        apiFetch(`${root}/projects`),
      ]);
      setRooms(r.rooms);
      setProjects(p.projects);
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
  function edit(kind, item) {
    setEditing({ kind, item });
    const defaults = kind === "room" ? roomDefaults : projectDefaults;
    form.reset(
      Object.fromEntries(
        Object.keys(defaults).map((key) => [key, item?.[key] ?? defaults[key]]),
      ),
    );
  }
  async function save(values) {
    form.clearErrors("root.server");
    try {
      await apiFetch(
        `${root}/${editing.kind === "room" ? "rooms" : "projects"}${editing.item ? `/${editing.item._id}` : ""}`,
        {
          method: editing.item ? "PATCH" : "POST",
          body: JSON.stringify(values),
        },
      );
      setEditing(null);
      notifySuccess("Changes saved");
      await load();
    } catch (err) {
      applyServerError(form, err);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await apiFetch(`${root}/rooms/${deleting._id}`, { method: "DELETE" });
      setDeleting(null);
      notifySuccess("Room deleted");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const data = new FormData();
      data.append("file", file);
      setPreview(await apiUpload(`${root}/import`, data));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`${root}/import/${preview.id}/confirm`, {
        method: "POST",
      });
      setPreview(null);
      notifySuccess("Import confirmed");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = projects.filter(
    (p) =>
      (filters.room === "all" || p.room?._id === filters.room) &&
      (filters.hardware === "all" || String(p.hardware) === filters.hardware) &&
      (!filters.category ||
        p.category.toLowerCase().includes(filters.category.toLowerCase())) &&
      (filters.unmatchedMembers === "all" ||
        String(p.unmatchedMembers.length > 0) === filters.unmatchedMembers),
  );
  const roomColumns = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "order", header: "Order" },
    { accessorKey: "capacity", header: "Capacity" },
    {
      accessorKey: "hardware",
      header: "Hardware",
      cell: ({ row }) => (row.original.hardware ? "Yes" : "No"),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => edit("room", row.original)}
          >
            Edit<span className="sr-only"> {row.original.name}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError("");
              setDeleting(row.original);
            }}
          >
            Delete<span className="sr-only"> {row.original.name}</span>
          </Button>
        </div>
      ),
    },
  ];
  const projectColumns = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "category", header: "Category" },
    {
      accessorKey: "hardware",
      header: "Hardware",
      cell: ({ row }) => (row.original.hardware ? "Yes" : "No"),
    },
    {
      id: "members",
      header: "Matched / unmatched",
      cell: ({ row }) =>
        `${row.original.members.length} / ${row.original.unmatchedMembers.length}`,
    },
    {
      id: "table",
      header: "Room / table",
      cell: ({ row }) =>
        `${row.original.room?.name || "Unassigned"} / ${row.original.tableNumber ?? "None"}`,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() => edit("project", row.original)}
        >
          Edit<span className="sr-only"> {row.original.name}</span>
        </Button>
      ),
    },
  ];
  const capacity = rooms.reduce((sum, r) => sum + r.capacity, 0);
  const hardwareCapacity = rooms
    .filter((r) => r.hardware)
    .reduce((sum, r) => sum + r.capacity, 0);
  return (
    <div className="space-y-6">
      <PageHeader title="Judging" />
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
      <Tabs defaultValue="rooms">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="rooms">Rooms</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
          <TabsTrigger value="calibration">Calibration</TabsTrigger>
        </TabsList>
        <TabsContent value="calibration">
          <AdminJudgingCalibration />
        </TabsContent>
        <TabsContent value="rooms" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              {capacity} tables for {projects.length} projects. Hardware:{" "}
              {hardwareCapacity} tables for{" "}
              {projects.filter((p) => p.hardware).length} projects.
            </p>
            <Button onClick={() => edit("room", null)}>Create room</Button>
          </div>
          <DataTable
            columns={roomColumns}
            data={rooms}
            loading={loading}
            emptyState={
              <EmptyState
                title="No rooms yet"
                description="Create a room to define table capacity."
              />
            }
          />
        </TabsContent>
        <TabsContent value="projects" className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <Filter
              label="Room"
              value={filters.room}
              onChange={(room) => setFilters({ ...filters, room })}
              options={[
                ["all", "All rooms"],
                ...rooms.map((r) => [r._id, r.name]),
              ]}
            />
            <Filter
              label="Hardware"
              value={filters.hardware}
              onChange={(hardware) => setFilters({ ...filters, hardware })}
              options={[
                ["all", "All projects"],
                ["true", "Hardware"],
                ["false", "Non-hardware"],
              ]}
            />
            <div className="space-y-2">
              <Label htmlFor="category-filter">Category</Label>
              <Input
                id="category-filter"
                value={filters.category}
                onChange={(e) =>
                  setFilters({ ...filters, category: e.target.value })
                }
              />
            </div>
            <Filter
              label="Unmatched members"
              value={filters.unmatchedMembers}
              onChange={(unmatchedMembers) =>
                setFilters({ ...filters, unmatchedMembers })
              }
              options={[
                ["all", "All projects"],
                ["true", "Has unmatched"],
                ["false", "All matched"],
              ]}
            />
          </div>
          <DataTable
            columns={projectColumns}
            data={filtered}
            loading={loading}
            emptyState={
              <EmptyState
                title="No projects found"
                description="Import projects or adjust the filters."
              />
            }
          />
        </TabsContent>
        <TabsContent value="import" className="space-y-4">
          <form onSubmit={upload} className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="csv-file">
                Devpost CSV (up to 2 MB and 2000 rows)
              </Label>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setPreview(null);
                }}
              />
            </div>
            <Button type="submit" disabled={!file || busy} loading={busy}>
              Preview import
            </Button>
          </form>
          {busy && !preview && <Skeleton className="h-16 w-full" />}
          {preview && (
            <div className="space-y-4" aria-live="polite">
              <p className="text-sm">
                New: {preview.preview.counts.new}. Updated:{" "}
                {preview.preview.counts.updated}. Unchanged:{" "}
                {preview.preview.counts.unchanged}. Errors:{" "}
                {preview.preview.counts.errors}.
              </p>
              <p className="text-sm text-muted-foreground">
                Preview expires after 30 minutes. Valid rows will be imported.
                Error rows will be skipped.
              </p>
              {preview.preview.unrecognizedColumns.length > 0 && (
                <Alert>
                  <AlertDescription>
                    Unrecognized columns:{" "}
                    {preview.preview.unrecognizedColumns.join(", ")}
                  </AlertDescription>
                </Alert>
              )}
              <DataTable
                columns={[
                  { accessorKey: "rowNumber", header: "Row" },
                  { accessorKey: "reason", header: "Error" },
                ]}
                data={preview.preview.errors}
                emptyState="No row errors"
              />
              <DataTable
                columns={[
                  { accessorKey: "rowNumber", header: "Row" },
                  { accessorKey: "project.name", header: "Project" },
                  { accessorKey: "status", header: "Change" },
                  {
                    id: "unmatched",
                    header: "Unmatched emails",
                    cell: ({ row }) => unmatched(row.original.project),
                  },
                ]}
                data={preview.preview.rows}
                emptyState="No valid projects"
              />
              <Button
                onClick={confirm}
                disabled={busy || preview.preview.rows.length === 0}
                loading={busy}
              >
                Confirm import
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !form.formState.isSubmitting) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing?.kind === "project"
                ? "Edit project overrides"
                : editing?.item
                  ? "Edit room"
                  : "Create room"}
            </DialogTitle>
            <DialogDescription>
              {editing?.kind === "project"
                ? "These fields will be preserved on later imports."
                : "Set room capacity and fill order."}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(save)} className="space-y-4">
              <Fields form={form} room={editing?.kind !== "project"} />
              {form.formState.errors.root?.server && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {form.formState.errors.root.server.message}
                  </AlertDescription>
                </Alert>
              )}
              <Button type="submit" loading={form.formState.isSubmitting}>
                Save changes
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Rooms with projects at tables cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" loading={busy} onClick={remove}>
              Delete room
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
