"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

// Waitlist mode for one application round: once this many applications in
// the round are accepted, new submissions are waitlisted automatically (and
// the applicant is emailed). Empty means no limit.
export default function WaitlistLimit({ round, onChanged }) {
  const [value, setValue] = useState(
    round.waitlistAfterAccepted ? String(round.waitlistAfterAccepted) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, {
        method: "PATCH",
        body: JSON.stringify({ waitlistAfterAccepted: value.trim() || null }),
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: "0.75rem" }}>
      <label className="field-label" htmlFor={`waitlist-${round._id}`}>
        Waitlist new applications after this many are accepted (empty = no
        limit)
      </label>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <input
          id={`waitlist-${round._id}`}
          className="input"
          type="number"
          min={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ maxWidth: 120 }}
        />
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto" }}
          disabled={saving}
          onClick={save}
        >
          Save limit
        </button>
      </div>
      {error
        ? <div className="alert-error" style={{ marginTop: "0.5rem" }}>
            {error}
          </div>
        : null}
    </div>
  );
}
