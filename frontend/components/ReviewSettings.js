"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

// Admin setting for the review queue: automatic flagging of suspicious
// applications on submit (nearly empty resume, resume without the
// applicant's name, same phone number or resume on another account).
export default function ReviewSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => setSettings(data.settings))
      .catch((err) => setError(err.message));
  }, []);

  async function toggle() {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          autoFlagApplications: !settings.autoFlagApplications,
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
        Application review
      </h2>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {!settings
        ? <p className="muted">Loading…</p>
        : <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
            }}
          >
            <div>
              <div style={{ fontWeight: 500 }}>
                Flag suspicious applications automatically
              </div>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {settings.autoFlagApplications
                  ? "On — new applications are flagged for reviewers when the resume is nearly empty or doesn't mention the applicant, or the phone number or resume is on another account."
                  : "Off — only reviewers flag applications."}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto", flexShrink: 0 }}
              disabled={saving}
              onClick={toggle}
            >
              {settings.autoFlagApplications ? "Turn off" : "Turn on"}
            </button>
          </div>}
    </div>
  );
}
