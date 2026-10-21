"use client";

import { useState } from "react";
import { openSignedLink } from "@/lib/api";

// A link-styled button for private files (resumes). Clicking asks the backend
// at `path` for a short-lived signed URL and opens it in a new tab; failures
// (no access, storage not configured, blocked pop-up) show inline.
export default function SignedLinkButton({ path, children }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setError("");
    setOpening(true);
    try {
      await openSignedLink(path);
    } catch (err) {
      setError(err.message);
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="link"
        onClick={open}
        disabled={opening}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          cursor: opening ? "wait" : "pointer",
        }}
      >
        {opening ? "Opening…" : children}
      </button>
      {error
        ? <span
            role="alert"
            style={{
              display: "block",
              color: "var(--danger)",
              fontSize: "0.82rem",
              marginTop: 4,
            }}
          >
            {error}
          </span>
        : null}
    </>
  );
}
