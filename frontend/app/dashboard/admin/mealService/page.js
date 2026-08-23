"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const MEAL_NAME_OPTIONS = [
  "Friday Dinner",
  "Saturday Breakfast",
  "Saturday Lunch",
  "Saturday Dinner",
  "Sunday Breakfast",
];

function toIso(localDateTime) {
  if (!localDateTime) return "";
  return new Date(localDateTime).toISOString();
}

export default function MealServicePage() {
  const user = useUser();
  const router = useRouter();

  const [name, setName] = useState(MEAL_NAME_OPTIONS[0]);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [createdFor, setCreatedFor] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (user.role !== "admin") router.replace("/dashboard");
  }, [user.role, router]);

  if (user.role !== "admin") {
    return null;
  }

  async function createMeal(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSuccess("");

    if (!startsAt || !endsAt) {
      setError("Please provide both start and end times.");
      setSaving(false);
      return;
    }

    if (!createdFor.trim()) {
      setError("Please provide an email address for createdFor.");
      setSaving(false);
      return;
    }

    const payload = {
      name,
      startsAt: toIso(startsAt),
      endsAt: toIso(endsAt),
      createdFor: createdFor.trim(),
    };

    try {
      await apiFetch("/api/admin/meals", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSuccess("Meal service created.");
      setStartsAt("");
      setEndsAt("");
      setCreatedFor("");
      setName(MEAL_NAME_OPTIONS[0]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}>
        Meal Service
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Manage meal-service configuration for event operations.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: "1rem",
          marginBottom: "1rem",
        }}
      >
        <section className="card" style={{ padding: "1.25rem", minHeight: 120 }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>Upcoming Services</h2>
          <div
            style={{
              border: "1px dashed var(--border)",
              borderRadius: 10,
              height: 58,
              display: "grid",
              placeItems: "center",
            }}
          >
            <span className="muted" style={{ fontSize: "0.85rem" }}>Blank area</span>
          </div>
        </section>

        <section className="card" style={{ padding: "1.25rem", minHeight: 120 }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.5rem" }}>Meal Capacity</h2>
          <div
            style={{
              border: "1px dashed var(--border)",
              borderRadius: 10,
              height: 58,
              display: "grid",
              placeItems: "center",
            }}
          >
            <span className="muted" style={{ fontSize: "0.85rem" }}>Blank area</span>
          </div>
        </section>
      </div>

      <section className="card" style={{ padding: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.25rem" }}>
          Create Meal Service
        </h2>
        <p className="muted" style={{ fontSize: "0.86rem", marginBottom: "1rem" }}>
          Sends POST /api/admin/meals with name, startsAt, endsAt, and createdFor.
        </p>

        {error ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>{error}</div> : null}
        {success ? <div className="alert-success" style={{ marginBottom: "0.75rem" }}>{success}</div> : null}

        <form onSubmit={createMeal}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "0.85rem",
            }}
          >
            <div>
              <label className="field-label" htmlFor="meal-name">Meal name</label>
              <select
                id="meal-name"
                className="select"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              >
                {MEAL_NAME_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="field-label" htmlFor="meal-start">Starts at</label>
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
              <label className="field-label" htmlFor="meal-end">Ends at</label>
              <input
                id="meal-end"
                className="input"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                required
              />
            </div>

            <div style={{ gridColumn: "1 / -1" }}>
              <label className="field-label" htmlFor="meal-created-for">Created for (email)</label>
              <input
                id="meal-created-for"
                className="input"
                type="email"
                placeholder="applicant@example.com"
                value={createdFor}
                onChange={(e) => setCreatedFor(e.target.value)}
                required
              />
            </div>
          </div>

          <div style={{ marginTop: "1rem", display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-primary" style={{ width: "auto" }} disabled={saving}>
              {saving ? "Creating..." : "Create Meal Service"}
            </button>
            <span className="muted" style={{ fontSize: "0.82rem" }}>
              Endpoint: /api/admin/meals
            </span>
          </div>
        </form>
      </section>
    </div>
  );
}
