"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import CheckInStation, {
  RecentScans,
  resultFromError,
  useStationLog,
} from "@/components/CheckInStation";
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
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Meal check-in
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Scan attendees&apos; QR codes at the meal line.
      </p>

      {loadError
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {loadError}
          </div>
        : null}

      {loading
        ? <p className="muted">Loading…</p>
        : meals.length === 0
          ? <div className="card" style={{ padding: "1.5rem" }}>
              <p className="muted">
                No active meals right now. An admin can set them up under Meals.
              </p>
            </div>
          : <>
              <div
                className="card"
                style={{ padding: "1.5rem", marginBottom: "1rem" }}
              >
                <label className="field-label" htmlFor="meal">
                  Serving
                </label>
                <select
                  id="meal"
                  className="select"
                  style={{ maxWidth: 420 }}
                  value={mealId}
                  onChange={(e) => {
                    setMealId(e.target.value);
                    log.clear();
                  }}
                >
                  {meals.map((m) => (
                    <option key={m._id} value={m._id}>
                      {m.name} ({m.checkInCount || 0} served)
                    </option>
                  ))}
                </select>
              </div>

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
