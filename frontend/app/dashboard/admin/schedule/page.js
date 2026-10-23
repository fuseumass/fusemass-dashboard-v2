"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

const EMPTY_FORM = {
  title: "",
  startsAt: "",
  endsAt: "",
  location: "",
  description: "",
  published: false,
};

// ISO string -> the "YYYY-MM-DDTHH:mm" local value a datetime-local input wants.
function toLocalInput(value) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatWhen(item) {
  const day = new Date(item.startsAt).toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  const end = new Date(item.endsAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} to ${end}`;
}

// Admin-only: the event's run of show. Attendees get it by email, as a
// calendar invite, the moment they check in.
export default function RunOfShowPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    return apiFetch("/api/admin/schedule")
      .then((data) => setItems(data.events || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  if (!isAdmin) return null;

  function setField(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function startEdit(item) {
    setEditingId(item._id);
    setError("");
    setForm({
      title: item.title,
      startsAt: toLocalInput(item.startsAt),
      endsAt: toLocalInput(item.endsAt),
      location: item.location || "",
      description: item.description || "",
      published: Boolean(item.published),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    const payload = {
      ...form,
      startsAt: new Date(form.startsAt).toISOString(),
      endsAt: new Date(form.endsAt).toISOString(),
    };
    try {
      await apiFetch(
        editingId ? `/api/admin/schedule/${editingId}` : "/api/admin/schedule",
        {
          method: editingId ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      notifySuccess(
        editingId ? "Schedule item updated." : "Schedule item added.",
      );
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item) {
    if (removing) return;
    setRemoving(true);
    setError("");
    try {
      await apiFetch(`/api/admin/schedule/${item._id}`, { method: "DELETE" });
      if (editingId === item._id) cancelEdit();
      setItems((list) => list.filter((i) => i._id !== item._id));
      setDeleting(null);
      notifySuccess("Schedule item removed.");
    } catch (err) {
      setError(err.message);
      setDeleting(null);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Run of show"
        description="Attendees receive the schedule as a calendar invite when they check in. Add meals here too if they belong on the schedule. Published items also appear on the event website and public calendar feed; other items stay private."
      />
      {error
        ? <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError("");
                  load();
                }}
              >
                Retry loading
              </Button>
            </AlertDescription>
          </Alert>
        : null}
      <Card>
        <CardHeader>
          <CardTitle>{editingId ? "Edit item" : "Add item"}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ros-title">Title</Label>
                <Input
                  id="ros-title"
                  placeholder="e.g. Opening ceremony"
                  value={form.title}
                  onChange={(e) => setField("title", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ros-location">Location (optional)</Label>
                <Input
                  id="ros-location"
                  placeholder="e.g. Main hall"
                  value={form.location}
                  onChange={(e) => setField("location", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ros-start">Starts</Label>
                <Input
                  id="ros-start"
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setField("startsAt", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ros-end">Ends</Label>
                <Input
                  id="ros-end"
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => setField("endsAt", e.target.value)}
                  required
                />
              </div>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Switch
                  id="ros-published"
                  checked={form.published}
                  onCheckedChange={(value) => setField("published", value)}
                />
                <Label htmlFor="ros-published">
                  Show on the public schedule (the event website)
                </Label>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="ros-description">Description (optional)</Label>
                <Textarea
                  id="ros-description"
                  rows={2}
                  value={form.description}
                  onChange={(e) => setField("description", e.target.value)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit" loading={saving}>
                {editingId ? "Save changes" : "Add to schedule"}
              </Button>
              {editingId
                ? <Button
                    type="button"
                    variant="outline"
                    onClick={cancelEdit}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                : null}
            </div>
          </form>
        </CardContent>
      </Card>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Where</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? <TableRow>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-10 w-full" />
                    <span className="sr-only">Loading schedule</span>
                  </TableCell>
                </TableRow>
              : items.length === 0
                ? <TableRow>
                    <TableCell
                      colSpan={4}
                      className="py-8 text-center text-muted-foreground"
                    >
                      Nothing scheduled yet. Add the first item above.
                    </TableCell>
                  </TableRow>
                : items.map((item) => (
                    <TableRow key={item._id}>
                      <TableCell className="align-top whitespace-nowrap tabular-nums">
                        {formatWhen(item)}
                      </TableCell>
                      <TableCell className="min-w-48 align-top">
                        <div className="flex items-center gap-2 font-medium">
                          {item.title}
                          {item.published
                            ? <Badge variant="secondary">Public</Badge>
                            : null}
                        </div>
                        {item.description
                          ? <p className="text-xs whitespace-pre-wrap text-muted-foreground">
                              {item.description}
                            </p>
                          : null}
                      </TableCell>
                      <TableCell className="align-top">
                        {item.location}
                      </TableCell>
                      <TableCell className="text-right align-top whitespace-nowrap">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={saving || removing}
                          onClick={() => startEdit(item)}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={saving || removing}
                          onClick={() => setDeleting(item)}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !removing) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove schedule item?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove {deleting?.title} from the run of show?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={removing}
              onClick={() => handleDelete(deleting)}
            >
              Remove item
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
