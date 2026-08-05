"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Admin-only: authentication settings, application rounds, and per-round form.
export default function SettingsPage() {
  const user = useUser();
  const router = useRouter();

  useEffect(() => {
    if (user.role !== "admin") router.replace("/dashboard");
  }, [user.role, router]);

  if (user.role !== "admin") return null;

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Settings
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Organization setup — visible to admins only.
      </p>
      <AuthSettings />
      <RoundsManager />
    </div>
  );
}

// ---- Google OAuth toggle ---------------------------------------------------

function AuthSettings() {
  const [settings, setSettings] = useState(null);
  const [envAllowed, setEnvAllowed] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setEnvAllowed(data.googleEnvAllowed);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function toggleGoogle() {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          googleAuthEnabled: !settings.googleAuthEnabled,
        }),
      });
      setSettings(data.settings);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ padding: "1.5rem", marginBottom: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Authentication
      </h2>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {!settings
        ? <p className="muted">Loading…</p>
        : !envAllowed
          ? <p className="muted">
              Google sign-in isn&apos;t configured on the server (missing
              credentials or disabled by env), so there&apos;s nothing to toggle
              here yet.
            </p>
          : <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>Sign in with Google</div>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {settings.googleAuthEnabled
                    ? "Enabled — applicants can use Google."
                    : "Disabled — hidden from login."}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                disabled={saving}
                onClick={toggleGoogle}
              >
                {settings.googleAuthEnabled ? "Turn off" : "Turn on"}
              </button>
            </div>}
    </div>
  );
}

// ---- Application rounds -----------------------------------------------------

function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function RoundsManager() {
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    apiFetch("/api/admin/rounds")
      .then((data) => setRounds(data.rounds))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createRound(e) {
    e.preventDefault();
    setError("");
    try {
      await apiFetch("/api/admin/rounds", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card" style={{ padding: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.25rem",
        }}
      >
        Application rounds
      </h2>
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        Create multiple cycles (e.g. Early, Regular, Late) and set when each
        opens and closes.
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      <form
        onSubmit={createRound}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem" }}
      >
        <input
          className="input"
          placeholder="New round name (e.g. Early Applications)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto", whiteSpace: "nowrap" }}
        >
          Add round
        </button>
      </form>

      {loading
        ? <p className="muted">Loading…</p>
        : rounds.length === 0
          ? <p className="muted">No rounds yet.</p>
          : <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {rounds.map((r) => (
                <RoundRow key={r._id} round={r} onChanged={load} />
              ))}
            </div>}
    </div>
  );
}

const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "checkbox",
  "date",
];

function fieldFromConfig(f) {
  return {
    _uid: crypto.randomUUID(),
    key: f?.key || "",
    label: f?.label || "",
    type: FIELD_TYPES.includes(f?.type) ? f.type : "text",
    required: Boolean(f?.required),
    options: Array.isArray(f?.options) ? f.options : [],
  };
}

function emptyField() {
  return fieldFromConfig(null);
}

function RoundRow({ round, onChanged }) {
  const [opensAt, setOpensAt] = useState(toLocalInput(round.opensAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(round.closesAt));
  const [showForm, setShowForm] = useState(false);
  const [fields, setFields] = useState(
    (round.formConfig || []).map(fieldFromConfig),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function updateField(index, patchObj) {
    setFields((fs) =>
      fs.map((f, i) => (i === index ? { ...f, ...patchObj } : f)),
    );
  }
  function addField() {
    setFields((fs) => [...fs, emptyField()]);
  }
  function removeField(index) {
    setFields((fs) => fs.filter((_, i) => i !== index));
  }
  function moveField(index, dir) {
    setFields((fs) => {
      const target = index + dir;
      if (target < 0 || target >= fs.length) return fs;
      const next = [...fs];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function patch(body) {
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveDates() {
    await patch({
      opensAt: opensAt ? new Date(opensAt).toISOString() : null,
      closesAt: closesAt ? new Date(closesAt).toISOString() : null,
    });
  }

  async function saveForm() {
    const payload = fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      options: f.options,
    }));
    await patch({ formConfig: payload });
  }

  async function remove() {
    if (!window.confirm(`Delete round "${round.name}"?`)) return;
    setSaving(true);
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {round.name}{" "}
          <span
            className="muted"
            style={{ fontWeight: 400, fontSize: "0.82rem" }}
          >
            {round.isOpen ? "· open" : "· closed"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", padding: "0.35rem 0.7rem" }}
            disabled={saving}
            onClick={() => patch({ isOpen: !round.isOpen })}
          >
            {round.isOpen ? "Close" : "Open"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", padding: "0.35rem 0.7rem" }}
            onClick={() => setShowForm((s) => !s)}
          >
            Edit form
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              width: "auto",
              padding: "0.35rem 0.7rem",
              color: "var(--danger)",
            }}
            disabled={saving}
            onClick={remove}
          >
            Delete
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "0.75rem",
          marginTop: "0.75rem",
        }}
      >
        <label style={{ display: "block" }}>
          <span className="field-label">Opens</span>
          <input
            className="input"
            type="datetime-local"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Closes</span>
          <input
            className="input"
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto" }}
            disabled={saving}
            onClick={saveDates}
          >
            Save dates
          </button>
        </div>
      </div>

      {showForm
        ? <div style={{ marginTop: "0.75rem" }}>
            <p
              className="muted"
              style={{ fontSize: "0.82rem", marginBottom: "0.75rem" }}
            >
              Extra questions applicants answer for this round, alongside the
              standard fields.
            </p>

            {fields.length === 0
              ? <p className="muted" style={{ marginBottom: "0.75rem" }}>
                  No extra fields yet.
                </p>
              : <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  {fields.map((field, index) => (
                    <FormFieldEditor
                      key={field._uid}
                      field={field}
                      isFirst={index === 0}
                      isLast={index === fields.length - 1}
                      onChange={(patchObj) => updateField(index, patchObj)}
                      onMoveUp={() => moveField(index, -1)}
                      onMoveDown={() => moveField(index, 1)}
                      onRemove={() => removeField(index)}
                    />
                  ))}
                </div>}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                onClick={addField}
              >
                + Add field
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                disabled={saving}
                onClick={saveForm}
              >
                Save form config
              </button>
            </div>
          </div>
        : null}

      {error
        ? <div className="alert-error" style={{ marginTop: "0.75rem" }}>
            {error}
          </div>
        : null}
    </div>
  );
}

function FormFieldEditor({
  field,
  isFirst,
  isLast,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}) {
  const optionsText = (field.options || []).join(", ");

  function setOptionsFromText(text) {
    const options = text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({ options });
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.75rem",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.5rem",
        }}
      >
        <label style={{ display: "block" }}>
          <span className="field-label">Key</span>
          <input
            className="input"
            value={field.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="e.g. dietary"
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Label</span>
          <input
            className="input"
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="e.g. Dietary restrictions"
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Type</span>
          <select
            className="select"
            value={field.type}
            onChange={(e) => onChange({ type: e.target.value })}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            paddingTop: "1.35rem",
          }}
        >
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          Required
        </label>
      </div>

      {field.type === "select"
        ? <label style={{ display: "block", marginTop: "0.5rem" }}>
            <span className="field-label">Options (comma-separated)</span>
            <input
              className="input"
              value={optionsText}
              onChange={(e) => setOptionsFromText(e.target.value)}
              placeholder="e.g. none, vegetarian, vegan"
            />
          </label>
        : null}

      <div style={{ display: "flex", gap: 6, marginTop: "0.5rem" }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", padding: "0.25rem 0.6rem" }}
          disabled={isFirst}
          onClick={onMoveUp}
        >
          ↑ Move up
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", padding: "0.25rem 0.6rem" }}
          disabled={isLast}
          onClick={onMoveDown}
        >
          ↓ Move down
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{
            width: "auto",
            padding: "0.25rem 0.6rem",
            color: "var(--danger)",
          }}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
