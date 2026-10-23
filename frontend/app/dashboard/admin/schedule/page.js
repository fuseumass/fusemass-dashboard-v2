"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
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
  return `${day} – ${end}`;
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
      cancelEdit();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(item) {
    if (!window.confirm(`Remove ${item.title} from the run of show?`)) return;
    setError("");
    try {
      await apiFetch(`/api/admin/schedule/${item._id}`, { method: "DELETE" });
      if (editingId === item._id) cancelEdit();
      setItems((list) => list.filter((i) => i._id !== item._id));
    } catch (err) {
      setError(err.message);
    }
  }

  const cell = { padding: "0.75rem 1rem", verticalAlign: "top" };

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Run of show
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        The event schedule. Attendees get it as a calendar invite in their
        &ldquo;You&apos;re checked in&rdquo; email. Meals are not added
        automatically; list them here too if they should be on it. Items marked
        public also appear on the hackathon website, through the public schedule
        feed (<code>/api/public/schedule</code>, plus <code>schedule.ics</code>{" "}
        for calendars); the rest stay private.
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      <form
        className="card"
        style={{ padding: "1.5rem", marginBottom: "1.5rem" }}
        onSubmit={handleSubmit}
      >
        <h2
          style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "1rem" }}
        >
          {editingId ? "Edit item" : "Add item"}
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "0.85rem",
          }}
        >
          <div>
            <label className="field-label" htmlFor="ros-title">
              Title
            </label>
            <input
              id="ros-title"
              className="input"
              placeholder="e.g. Opening ceremony"
              value={form.title}
              onChange={(e) => setField("title", e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="ros-start">
              Starts
            </label>
            <input
              id="ros-start"
              className="input"
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setField("startsAt", e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="ros-end">
              Ends
            </label>
            <input
              id="ros-end"
              className="input"
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setField("endsAt", e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="ros-location">
              Location (optional)
            </label>
            <input
              id="ros-location"
              className="input"
              placeholder="e.g. Main hall"
              value={form.location}
              onChange={(e) => setField("location", e.target.value)}
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <input
                type="checkbox"
                checked={form.published}
                onChange={(e) => setField("published", e.target.checked)}
              />
              Show on the public schedule (the hackathon website)
            </label>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label className="field-label" htmlFor="ros-description">
              Description (optional)
            </label>
            <textarea
              id="ros-description"
              className="textarea"
              rows={2}
              value={form.description}
              onChange={(e) => setField("description", e.target.value)}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: "auto" }}
            disabled={saving}
          >
            {saving
              ? "Saving…"
              : editingId
                ? "Save changes"
                : "Add to schedule"}
          </button>
          {editingId
            ? <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                onClick={cancelEdit}
              >
                Cancel
              </button>
            : null}
        </div>
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
              <th style={{ ...cell, fontWeight: 600 }}>When</th>
              <th style={{ ...cell, fontWeight: 600 }}>What</th>
              <th style={{ ...cell, fontWeight: 600 }}>Where</th>
              <th style={cell} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading
              ? <tr>
                  <td colSpan={4} style={cell} className="muted">
                    Loading…
                  </td>
                </tr>
              : items.length === 0
                ? <tr>
                    <td colSpan={4} style={cell} className="muted">
                      Nothing scheduled yet.
                    </td>
                  </tr>
                : items.map((item) => (
                    <tr
                      key={item._id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        {formatWhen(item)}
                      </td>
                      <td style={cell}>
                        <div style={{ fontWeight: 600 }}>
                          {item.title}
                          {item.published
                            ? <span
                                className="chip"
                                style={{ marginLeft: 8, fontWeight: 400 }}
                              >
                                Public
                              </span>
                            : null}
                        </div>
                        {item.description
                          ? <div
                              className="muted"
                              style={{ fontSize: "0.82rem" }}
                            >
                              {item.description}
                            </div>
                          : null}
                      </td>
                      <td style={cell}>{item.location}</td>
                      <td
                        style={{
                          ...cell,
                          textAlign: "right",
                          whiteSpace: "nowrap",
                        }}
                      >
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ width: "auto", marginRight: 6 }}
                          onClick={() => startEdit(item)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ width: "auto" }}
                          onClick={() => handleDelete(item)}
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
