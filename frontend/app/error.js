"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

// Last-resort boundary for any page outside the dashboard (login, signup,
// the public application form). Errors inside the dashboard are caught one
// level lower, by app/dashboard/error.js, so the sidebar survives.
export default function RootError({ error, unstable_retry }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ErrorState
        title="This page hit an error"
        message="Something unexpected stopped the page from loading. Try again, and reload the page if it keeps happening."
        onRetry={unstable_retry}
      />
    </main>
  );
}
