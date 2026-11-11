"use client";

import { Package } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import HardwareStation from "@/components/HardwareStation";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Skeleton } from "@/components/ui/skeleton";
import { apiDownload, apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { applyServerError, zodResolver } from "@/lib/forms";
import { useUser } from "@/lib/userContext";

const itemFields = [
  ["name", "Name"],
  ["category", "Category"],
  ["location", "Location"],
  ["description", "Description"],
  ["link", "Documentation URL"],
  ["imageUrl", "Image URL"],
  ["totalQty", "Total quantity", "number"],
  ["maxPerAttendee", "Maximum per attendee", "number"],
];
const facilityFields = [
  ["name", "Name"],
  ["location", "Location"],
  ["accessNotes", "Access notes"],
];
const emptyItem = {
  name: "",
  category: "",
  location: "",
  description: "",
  link: "",
  imageUrl: "",
  totalQty: 0,
  maxPerAttendee: 1,
};
const itemSchema = z.object({
  name: z.string().trim().min(1, "Enter a name."),
  category: z.string(),
  location: z.string(),
  description: z.string(),
  link: z.string(),
  imageUrl: z.string(),
  totalQty: z.coerce.number().int().min(0),
  maxPerAttendee: z.coerce.number().int().min(1),
});
const facilitySchema = z.object({
  name: z.string().trim().min(1, "Enter a name."),
  location: z.string(),
  accessNotes: z.string(),
});

function RecordEditor({ record, facility, onClose, onSave }) {
  const form = useForm({
    resolver: zodResolver(facility ? facilitySchema : itemSchema),
    defaultValues: facility
      ? { name: "", location: "", accessNotes: "", ...record }
      : { ...emptyItem, ...record },
  });
  async function save(values) {
    try {
      await apiFetch(
        `/api/admin/hardware/${facility ? "facilities" : "items"}${record._id ? `/${record._id}` : ""}`,
        { method: record._id ? "PATCH" : "POST", body: JSON.stringify(values) },
      );
      await onSave();
      onClose();
    } catch (err) {
      applyServerError(form, err);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.formState.isSubmitting) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {record._id ? "Edit" : "Create"} {facility ? "facility" : "item"}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(save)} className="space-y-4">
            {(facility ? facilityFields : itemFields).map(
              ([name, label, type]) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{label}</FormLabel>
                      <FormControl>
                        <Input {...field} type={type || "text"} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ),
            )}
            {form.formState.errors.root?.server && (
              <Alert variant="destructive">
                <AlertDescription>
                  {form.formState.errors.root.server.message}
                </AlertDescription>
              </Alert>
            )}
            <Button type="submit" loading={form.formState.isSubmitting}>
              Save {facility ? "facility" : "item"}
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/** @param {object} props - Page mode. @returns {object} Hardware workspace. */
export default function HardwareLab({ mode }) {
  const user = useUser();
  const allowed =
    mode === "admin"
      ? user.role === "admin"
      : mode === "staff"
        ? ["admin", "moderator"].includes(user.role)
        : true;
  const [items, setItems] = useState([]);
  const [facilities, setFacilities] = useState([]);
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [editor, setEditor] = useState(null);
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState(null);
  const [labels, setLabels] = useState(null);
  const [defaultDueAt, setDefaultDueAt] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const base = mode === "attendee" ? "/api/hardware" : `/api/${mode}/hardware`;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch(base);
      setItems(data.items);
      setFacilities(data.facilities);
      setDefaultDueAt(data.defaultDueAt || null);
      if (mode === "attendee")
        setLoans((await apiFetch("/api/hardware/mine")).checkouts);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [base, mode]);
  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);
  // Stock refresh after a desk checkout or return, without the skeleton.
  async function reloadStock() {
    try {
      const data = await apiFetch(base);
      setItems(data.items);
      setDefaultDueAt(data.defaultDueAt || null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function run(action, message) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (message) setNotice(message);
    } catch (err) {
      setError(err.message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const filtered = items.filter(
    (item) =>
      (category === "all" || item.category === category) &&
      `${item._id} ${item.name} ${item.description} ${item.location}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const itemColumns = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "category", header: "Category" },
    { accessorKey: "location", header: "Location" },
    {
      id: "stock",
      header: "Availability",
      cell: ({ row }) => (
        <Badge variant="secondary">
          {row.original.availableQty} / {row.original.totalQty}
        </Badge>
      ),
    },
  ];
  if (mode === "admin")
    itemColumns.push({
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditor({ record: row.original })}
          >
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setConfirm({
                label: `Archive ${row.original.name}`,
                action: async () => {
                  await apiFetch(
                    `/api/admin/hardware/items/${row.original._id}`,
                    { method: "DELETE" },
                  );
                  await load();
                },
              })
            }
          >
            Archive
          </Button>
        </div>
      ),
    });
  const loanColumns = [
    {
      id: "item",
      header: "Item",
      cell: ({ row }) => row.original.item?.name || "Archived item",
    },
    {
      accessorKey: "checkedOutAt",
      header: "Checked out",
      cell: ({ getValue }) => formatDateTime(getValue()),
    },
    {
      accessorKey: "dueAt",
      header: "Due",
      cell: ({ row }) => (
        <span
          className={
            !row.original.returnedAt &&
            row.original.dueAt &&
            new Date(row.original.dueAt) < new Date()
              ? "text-destructive"
              : ""
          }
        >
          {row.original.dueAt
            ? formatDateTime(row.original.dueAt)
            : "Before leaving"}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.returnedAt
          ? `Returned ${formatDateTime(row.original.returnedAt)}`
          : <Badge variant="secondary">On loan</Badge>,
    },
  ];
  if (!allowed)
    return (
      <Alert>
        <AlertDescription>
          You do not have access to this screen.
        </AlertDescription>
      </Alert>
    );
  const myHardwareSection = (
    <section className="space-y-4">
      <h2 className="text-base font-semibold">My hardware</h2>
      <DataTable
        columns={loanColumns}
        data={loans}
        loading={loading}
        emptyState={<EmptyState title="You have no hardware loans." />}
      />
    </section>
  );
  const facilitiesSection = (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Facilities</h2>
        {mode === "admin" && (
          <Button
            variant="outline"
            onClick={() => setEditor({ facility: true, record: {} })}
          >
            Create facility
          </Button>
        )}
      </div>
      {loading
        ? <Skeleton className="h-20 w-full" />
        : <DataTable
            data={facilities}
            columns={[
              { accessorKey: "name", header: "Name" },
              { accessorKey: "location", header: "Location" },
              { accessorKey: "accessNotes", header: "Access notes" },
              ...(mode === "admin"
                ? [
                    {
                      id: "actions",
                      header: "Actions",
                      cell: ({ row }) => (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setEditor({
                                facility: true,
                                record: row.original,
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setConfirm({
                                label: `Remove ${row.original.name}`,
                                action: async () => {
                                  await apiFetch(
                                    `/api/admin/hardware/facilities/${row.original._id}`,
                                    { method: "DELETE" },
                                  );
                                  await load();
                                },
                              })
                            }
                          >
                            Remove
                          </Button>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
            emptyState={<EmptyState title="No facilities listed." />}
          />}
    </section>
  );
  return (
    <div className="space-y-6">
      <PageHeader
        title={
          mode === "admin"
            ? "Hardware inventory"
            : mode === "staff"
              ? "Hardware station"
              : "Hardware lab"
        }
        actions={
          mode === "admin" && (
            <Button onClick={() => setEditor({ record: {} })}>
              Create item
            </Button>
          )
        }
      />
      <div aria-live="polite">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error}
              <Button variant="outline" size="sm" onClick={load}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {notice && <p className="text-sm text-success">{notice}</p>}
      </div>
      {mode === "staff" && (
        <HardwareStation
          items={items}
          defaultDueAt={defaultDueAt}
          onInventoryChange={reloadStock}
        />
      )}
      {/* Participants see what they have and where to build first. */}
      {mode === "attendee" && myHardwareSection}
      {mode === "attendee" && facilitiesSection}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">
          {mode === "attendee" ? "Browse hardware" : "Inventory"}
        </h2>
        <div className="space-y-2">
          <Label htmlFor="hardware-search">Search hardware</Label>
          <Input
            id="hardware-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, description or location"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {[
            "all",
            ...new Set(items.map((item) => item.category).filter(Boolean)),
          ].map((value) => (
            <Button
              key={value}
              size="sm"
              variant={category === value ? "default" : "outline"}
              onClick={() => setCategory(value)}
            >
              {value === "all" ? "All categories" : value}
            </Button>
          ))}
        </div>
        <DataTable
          columns={itemColumns}
          data={filtered}
          loading={loading}
          emptyState={
            <EmptyState icon={Package} title="No hardware matches this view." />
          }
        />
        {mode === "attendee" &&
          filtered.map((item) => (
            <details key={item._id} className="rounded-md border p-3 text-sm">
              <summary className="cursor-pointer font-medium">
                {item.name}: details
              </summary>
              <p className="mt-2 whitespace-pre-wrap">
                {item.description ||
                  "Ask the hardware desk for usage instructions."}
              </p>
              <p className="text-muted-foreground">
                {item.location}. Limit: {item.maxPerAttendee} per attendee.
              </p>
              {item.link && (
                <a
                  className="text-link underline"
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  Documentation
                </a>
              )}
            </details>
          ))}
      </section>
      {mode === "admin" && (
        <section className="space-y-4">
          <h2 className="text-base font-semibold">Import and labels</h2>
          <p className="text-sm text-muted-foreground">
            CSV columns: name, category, description, link, location, imageUrl,
            totalQty, maxPerAttendee. Import adds new items. Preview before
            importing.
          </p>
          <Label htmlFor="hardware-csv">Inventory CSV</Label>
          <Input
            id="hardware-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              setPreview(null);
              setCsvText("");
              if (file)
                run(async () => {
                  if (file.size > 500000)
                    throw new Error("Choose a CSV under 500 KB.");
                  setCsvText(await file.text());
                });
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!csvText}
              loading={busy}
              onClick={() =>
                run(async () =>
                  setPreview(
                    (
                      await apiFetch("/api/admin/hardware/import", {
                        method: "POST",
                        body: JSON.stringify({ csv: csvText, preview: true }),
                      })
                    ).items,
                  ),
                )
              }
            >
              Preview import
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    apiDownload(
                      "/api/staff/hardware/export.csv?kind=inventory",
                      "hardware-inventory.csv",
                    ),
                  "CSV downloaded.",
                )
              }
            >
              Export inventory
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                run(async () =>
                  setLabels(
                    (await apiFetch("/api/admin/hardware/labels")).labels,
                  ),
                )
              }
            >
              Prepare labels
            </Button>
          </div>
          {preview && (
            <>
              <DataTable columns={itemColumns.slice(0, 3)} data={preview} />
              <Button
                loading={busy}
                onClick={() =>
                  run(async () => {
                    await apiFetch("/api/admin/hardware/import", {
                      method: "POST",
                      body: JSON.stringify({ csv: csvText, preview: false }),
                    });
                    setPreview(null);
                    setCsvText("");
                    await load();
                  }, "Inventory imported.")
                }
              >
                Import {preview.length} items
              </Button>
            </>
          )}
          {labels && (
            <Dialog
              open
              onOpenChange={(open) => {
                if (!open) setLabels(null);
              }}
            >
              <DialogContent className="max-h-[85vh] overflow-y-auto print:static print:max-h-none print:max-w-none print:overflow-visible">
                <DialogHeader className="print:hidden">
                  <DialogTitle>Hardware labels</DialogTitle>
                </DialogHeader>
                <Button className="print:hidden" onClick={() => window.print()}>
                  Print labels
                </Button>
                <div className="grid grid-cols-2 gap-4 print:grid-cols-3 hardware-label-sheet">
                  {labels.map((label) => (
                    <div
                      key={label.id}
                      className="break-inside-avoid rounded-md border p-3 text-center"
                    >
                      <Image
                        unoptimized
                        src={label.qr}
                        alt={`QR label for ${label.name}`}
                        width="160"
                        height="160"
                        className="mx-auto"
                      />
                      <p className="text-sm font-medium">{label.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {label.location}
                      </p>
                    </div>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
          )}
        </section>
      )}
      {mode !== "attendee" && facilitiesSection}
      {editor && (
        <RecordEditor
          {...editor}
          onClose={() => setEditor(null)}
          onSave={async () => {
            await load();
            setNotice("Changes saved.");
          }}
        />
      )}
      {confirm && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open && !busy) setConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.label}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogDescription>
              Confirm this action at the hardware desk.
            </AlertDialogDescription>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button
              loading={busy}
              onClick={() =>
                run(async () => {
                  await confirm.action();
                  setConfirm(null);
                }, "Action completed.")
              }
            >
              Confirm
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </Button>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
