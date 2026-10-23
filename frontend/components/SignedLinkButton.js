"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
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
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-left font-medium whitespace-normal"
        onClick={open}
        loading={opening}
      >
        {opening ? "Opening" : children}
      </Button>
      {error
        ? <span
            role="alert"
            className="mt-1 block text-[0.8rem] text-destructive"
          >
            {error}
          </span>
        : null}
    </>
  );
}
