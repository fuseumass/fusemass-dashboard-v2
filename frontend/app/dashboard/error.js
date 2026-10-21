"use client";

import { useEffect } from "react";
import ErrorState from "@/components/ErrorState";

// Catches a crash inside one dashboard page. It renders in the content area,
// so the sidebar and top bar stay usable and the user can navigate away.
export default function DashboardError({ error, unstable_retry }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <ErrorState
      title="This page hit an error"
      message="Something unexpected stopped it from loading. Try again, or open another page from the menu."
      onRetry={unstable_retry}
      className="py-16"
    />
  );
}
