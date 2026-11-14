"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { isAcceptedOrStaff } from "@/lib/nav";
import { useUser } from "@/lib/userContext";

/**
 * Send anyone who isn't accepted (or staff) back to their home page.
 * @returns {boolean} Whether the page may render.
 */
export function useAcceptedOnly() {
  const user = useUser();
  const router = useRouter();
  const allowed = isAcceptedOrStaff(user);
  useEffect(() => {
    if (!allowed) router.replace("/dashboard");
  }, [allowed, router]);
  return allowed;
}
