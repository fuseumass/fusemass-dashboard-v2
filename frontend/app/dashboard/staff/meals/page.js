"use client";

import { Sandwich } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CheckInStation, {
  RecentScans,
  resultFromError,
  useStationLog,
} from "@/components/CheckInStation";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Moderators + admins: the meal line. Pick the active meal, then scan; each
// attendee can be served once per meal. Admins set meals up under Meals.
export default function StaffMealCheckInPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";
  const log = useStationLog();

  const [meals, setMeals] = useState([]);
  const [mealId, setMealId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
  }, [isStaff, router]);

  useEffect(() => {
    if (!isStaff) return;
    apiFetch("/api/staff/meals")
      .then((data) => {
        const active = (data.meals || []).filter((m) => m.active);
        setMeals(active);
        if (active.length > 0) setMealId(active[0]._id);
      })
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, [isStaff]);

  if (!isStaff) return null;

  const meal = meals.find((m) => m._id === mealId) || null;

  async function serve(code) {
    if (!meal) return;
    try {
      const data = await apiFetch(`/api/staff/meals/${meal._id}/checkin`, {
        method: "POST",
        body: JSON.stringify({ qrId: code }),
      });
      setMeals((list) =>
        list.map((m) =>
          m._id === meal._id
            ? { ...m, checkInCount: (m.checkInCount || 0) + 1 }
            : m,
        ),
      );
      log.record({
        kind: "success",
        attendee: data.attendee,
        message: `Served ${meal.name}`,
        warning: data.attendee.eventCheckedIn
          ? ""
          : "Not checked in to the event yet. Send them to the check-in desk.",
      });
    } catch (err) {
      log.record(resultFromError(err));
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <PageHeader
        className="mb-2"
        title="Meal check-in"
        description="Scan attendees' QR codes at the meal line."
      />

      {loadError
        ? <Alert variant="destructive">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        : null}

      {loading
        ? <CardSkeleton lines={2} />
        : meals.length === 0
          ? <Card>
              <EmptyState
                icon={Sandwich}
                title="No active meals"
                description="An admin can set meals up under Meals."
              />
            </Card>
          : <>
              <Card>
                <CardContent className="space-y-1.5">
                  <Label htmlFor="meal">Serving</Label>
                  <Select
                    value={mealId}
                    onValueChange={(value) => {
                      setMealId(value);
                      log.clear();
                    }}
                  >
                    <SelectTrigger id="meal" className="h-10 w-full">
                      <SelectValue placeholder="Pick a meal" />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {meals.map((m) => (
                        <SelectItem key={m._id} value={m._id}>
                          {m.name} ({m.checkInCount || 0} served)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </CardContent>
              </Card>

              <CheckInStation
                title={meal ? `Scan for ${meal.name}` : "Scan"}
                onCode={serve}
                result={log.result}
              />

              <RecentScans recent={log.recent} />
            </>}
    </div>
  );
}
