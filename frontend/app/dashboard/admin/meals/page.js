"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
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
  return `${new Date(meal.startsAt).toLocaleString([], opts)} – ${new Date(
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
  const [success, setSuccess] = useState("");

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
    setSuccess("");
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
      setSuccess(`${name.trim()} created.`);
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

  async function handleDelete(meal) {
    if (!window.confirm(`Delete ${meal.name}?`)) return;
    setError("");
    try {
      await apiFetch(`/api/admin/meals/${meal._id}`, { method: "DELETE" });
      setMeals((list) => list.filter((m) => m._id !== meal._id));
    } catch (err) {
      setError(err.message);
    }
  }

  const cell = { padding: "0.75rem 1rem" };

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Meals
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Set up meal services. Staff pick an active meal on the Check-in page and
        scan attendees&apos; QR codes; each attendee can be served once per
        meal.
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}
      {success
        ? <div className="alert-success" style={{ marginBottom: "1rem" }}>
            {success}
          </div>
        : null}

      <form
        className="card"
        style={{ padding: "1.5rem", marginBottom: "1.5rem" }}
        onSubmit={handleCreate}
      >
        <h2
          style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "1rem" }}
        >
          New meal
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "0.85rem",
          }}
        >
          <div>
            <label className="field-label" htmlFor="meal-name">
              Name
            </label>
            <input
              id="meal-name"
              className="input"
              list="meal-name-suggestions"
              placeholder="e.g. Saturday Lunch"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <datalist id="meal-name-suggestions">
              {MEAL_NAME_SUGGESTIONS.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="field-label" htmlFor="meal-start">
              Starts
            </label>
            <input
              id="meal-start"
              className="input"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="meal-end">
              Ends
            </label>
            <input
              id="meal-end"
              className="input"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              required
            />
          </div>
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto", marginTop: "1rem" }}
          disabled={saving}
        >
          {saving ? "Creating…" : "Create meal"}
        </button>
      </form>

      <div className="card" style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.9rem",
          }}
        >
          <thead>
            <tr
              style={{
                textAlign: "left",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <th style={{ ...cell, fontWeight: 600 }}>Meal</th>
              <th style={{ ...cell, fontWeight: 600 }}>When</th>
              <th style={{ ...cell, fontWeight: 600 }}>Served</th>
              <th style={{ ...cell, fontWeight: 600 }}>Active</th>
              <th style={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading
              ? <tr>
                  <td colSpan={5} style={cell} className="muted">
                    Loading…
                  </td>
                </tr>
              : meals.length === 0
                ? <tr>
                    <td colSpan={5} style={cell} className="muted">
                      No meals yet.
                    </td>
                  </tr>
                : meals.map((meal) => (
                    <tr
                      key={meal._id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td style={{ ...cell, fontWeight: 600 }}>{meal.name}</td>
                      <td style={cell}>{formatWindow(meal)}</td>
                      <td style={cell}>{meal.checkInCount || 0}</td>
                      <td style={cell}>
                        <input
                          type="checkbox"
                          aria-label={`${meal.name} active`}
                          checked={meal.active}
                          onChange={(e) => setActive(meal, e.target.checked)}
                        />
                      </td>
                      <td style={{ ...cell, textAlign: "right" }}>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ width: "auto" }}
                          disabled={meal.checkInCount > 0}
                          title={
                            meal.checkInCount > 0
                              ? "Already served; deactivate it instead."
                              : undefined
                          }
                          onClick={() => handleDelete(meal)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
