"use client";

import { Sandwich } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { TableRowsSkeleton } from "@/components/skeletons";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

// Suggestions only; any name can be typed.
const MEAL_NAME_SUGGESTIONS = [
  "Friday Dinner",
  "Saturday Breakfast",
  "Saturday Lunch",
  "Saturday Dinner",
  "Midnight Snack",
  "Sunday Breakfast",
];

function formatWindow(meal) {
  const opts = { weekday: "short", hour: "numeric", minute: "2-digit" };
  return `${new Date(meal.startsAt).toLocaleString([], opts)} to ${new Date(
    meal.endsAt,
  ).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

// Admin-only: set up the meal services staff check attendees into. Only
// active meals show up on the check-in station.
export default function AdminMealsPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const [meals, setMeals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(null);
  // Deleting takes two steps: a warning, then typing the meal's exact name.
  const [confirmingName, setConfirmingName] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [deletePending, setDeletePending] = useState(false);

  const load = useCallback(() => {
    return apiFetch("/api/admin/meals")
      .then((data) => setMeals(data.meals || []))
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

  async function handleCreate(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await apiFetch("/api/admin/meals", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
        }),
      });
      notifySuccess(`${name.trim()} created.`);
      setName("");
      setStartsAt("");
      setEndsAt("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function setActive(meal, active) {
    setError("");
    try {
      const data = await apiFetch(`/api/admin/meals/${meal._id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
      setMeals((list) =>
        list.map((m) => (m._id === meal._id ? { ...m, ...data.meal } : m)),
      );
    } catch (err) {
      setError(err.message);
    }
  }

  function closeDelete() {
    setDeleting(null);
    setConfirmingName(false);
    setTypedName("");
  }

  async function handleDelete(meal) {
    setError("");
    setDeletePending(true);
    try {
      const result = await apiFetch(`/api/admin/meals/${meal._id}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmName: typedName }),
      });
      setMeals((list) => list.filter((m) => m._id !== meal._id));
      notifySuccess(
        result.checkInsRemoved
          ? `${meal.name} deleted with ${result.checkInsRemoved} check-ins.`
          : `${meal.name} deleted.`,
      );
      closeDelete();
    } catch (err) {
      setError(err.message);
      closeDelete();
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        className="mb-0"
        title="Meals"
        description="Staff pick an active meal on the meal check-in page and scan QR codes. Each attendee can be served once per meal."
      />

      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}

      <Card>
        <CardHeader>
          <CardTitle>New meal</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label htmlFor="meal-name">Name</Label>
                <Input
                  id="meal-name"
                  list="meal-name-suggestions"
                  placeholder="e.g. Saturday Lunch"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <datalist id="meal-name-suggestions">
                  {MEAL_NAME_SUGGESTIONS.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="meal-start">Starts</Label>
                <Input
                  id="meal-start"
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="meal-end">Ends</Label>
                <Input
                  id="meal-end"
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                />
              </div>
            </div>
            <Button
              type="submit"
              loading={saving}
              disabled={!name.trim() || !startsAt || !endsAt}
            >
              {saving ? "Creating" : "Create meal"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="py-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Meal</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="text-right">Served</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? <TableRowsSkeleton rows={3} columns={5} />
              : meals.length === 0
                ? <TableRow>
                    <TableCell colSpan={5}>
                      <EmptyState
                        icon={Sandwich}
                        title="No meals yet"
                        description="Create the first meal above."
                      />
                    </TableCell>
                  </TableRow>
                : meals.map((meal) => (
                    <TableRow key={meal._id}>
                      <TableCell className="font-medium">{meal.name}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                        {formatWindow(meal)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {meal.checkInCount || 0}
                      </TableCell>
                      <TableCell>
                        <Switch
                          size="sm"
                          aria-label={`${meal.name} active`}
                          checked={meal.active}
                          onCheckedChange={(checked) =>
                            setActive(meal, checked)
                          }
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleting(meal)}
                        >
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </Card>

      <AlertDialog
        open={Boolean(deleting) && !confirmingName}
        onOpenChange={(open) => {
          if (!open) closeDelete();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting?.checkInCount > 0
                ? `${deleting.checkInCount} people have been served this meal. Deleting it also deletes their check-ins, so the meal counts and exports lose them, and a meal created later with the same name starts with nobody served.`
                : "The meal is removed from the check-in station."}{" "}
              This cannot be undone. To keep the record, turn the meal off
              instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmingName(true)}
            >
              Continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deleting) && confirmingName}
        onOpenChange={(open) => {
          if (!open && !deletePending) closeDelete();
        }}
      >
        <AlertDialogContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (typedName === deleting?.name) handleDelete(deleting);
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm deleting this meal</AlertDialogTitle>
              <AlertDialogDescription>
                Type <strong className="font-mono">{deleting?.name}</strong> to
                confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-2">
              <Label htmlFor="confirm-meal-name">Meal name</Label>
              <Input
                id="confirm-meal-name"
                autoComplete="off"
                autoFocus
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deletePending}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                loading={deletePending}
                disabled={typedName !== deleting?.name}
              >
                Delete this meal
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
