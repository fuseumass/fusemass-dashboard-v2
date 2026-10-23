"use client";

import { Flag } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";

// A small marker for flagged applications in the review table.
export function FlagBadge() {
  return (
    <span
      title="Flagged for a closer look"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        marginLeft: 6,
        color: "#d97706",
        fontSize: "0.75rem",
        fontWeight: 600,
      }}
    >
      <Flag size={12} aria-hidden="true" />
      Flagged
    </span>
  );
}

// In the review drawer: why an application is flagged (and by whom), with
// moderator controls to flag it with a reason or clear the flag. `onChanged`
// receives the updated application from the API.
export function FlagPanel({ app, onChanged }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function send(method, body) {
    setBusy(true);
    setError("");
    try {
      const data = await apiFetch(`/api/admin/applications/${app._id}/flag`, {
        method,
        body,
      });
      setReason("");
      onChanged(data.application);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.75rem",
        margin: "0.75rem 0",
      }}
    >
      {app.flagged
        ? <>
            <div style={{ fontWeight: 600, color: "#d97706" }}>
              <Flag size={14} aria-hidden="true" /> Flagged
              {app.flaggedBy?.name ? ` by ${app.flaggedBy.name}` : ""}
            </div>
            <ul
              style={{ margin: "0.4rem 0 0.6rem 1.1rem", fontSize: "0.9rem" }}
            >
              {(app.flagReasons || []).map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto" }}
              disabled={busy}
              onClick={() => send("DELETE")}
            >
              Clear flag
            </button>
          </>
        : <div className="muted" style={{ fontSize: "0.85rem" }}>
            Not flagged.
          </div>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) send("POST", JSON.stringify({ reason }));
        }}
        style={{ display: "flex", gap: 6, marginTop: "0.6rem" }}
      >
        <input
          className="input"
          value={reason}
          maxLength={300}
          placeholder={app.flagged ? "Add another reason" : "Reason to flag"}
          aria-label="Reason to flag"
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="submit"
          className="btn btn-ghost"
          style={{ width: "auto" }}
          disabled={busy || !reason.trim()}
        >
          Flag
        </button>
      </form>
      {error
        ? <div className="alert-error" style={{ marginTop: "0.5rem" }}>
            {error}
          </div>
        : null}
    </div>
  );
}
