"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import AppSidebar from "@/components/Sidebar";
import { PageSkeleton } from "@/components/skeletons";
import Topbar from "@/components/Topbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import VerifyEmailNotice from "@/components/VerifyEmailNotice";
import { apiFetch, getToken } from "@/lib/api";
import { useFeatures } from "@/lib/features";
import { getNavGroups, isKioskPath } from "@/lib/nav";
import { UserContext } from "@/lib/userContext";
import { cn } from "@/lib/utils";

// Shared shell for every logged-in page: auth guard + navigation. Fetches the
// current user once and shares it via context so child pages don't refetch.
export default function DashboardLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Module flags (B25): nav items of a module an admin switched off are hidden.
  const features = useFeatures();

  useEffect(() => {
    // No token at all means the visitor was never logged in — send them to
    // login plainly, with none of the "your session expired" framing.
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    apiFetch("/api/auth/me")
      .then((data) => setUser(data.user))
      // An expired token is handled centrally in lib/api.js, which has already
      // navigated away by now. Anything still landing here is a genuine
      // failure (API down, network), so show it rather than bouncing the user
      // to login and implying they were signed out.
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [router]);

  useEffect(() => {
    if (user?.role === "judge" && pathname !== "/dashboard/judging") {
      router.replace("/dashboard/judging");
    }
  }, [user, pathname, router]);

  const groups = useMemo(() => getNavGroups(user, features), [user, features]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl p-6">
        <PageSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <Alert variant="destructive" className="max-w-md">
          <AlertTitle>Couldn&apos;t load your account</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!user || (user.role === "judge" && pathname !== "/dashboard/judging")) {
    return null;
  }

  // Scanning screens drop the sidebar and use the full width (see lib/nav.js).
  const kiosk = isKioskPath(pathname);

  return (
    <UserContext.Provider value={user}>
      <SidebarProvider>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:ring-2 focus:ring-ring"
        >
          Skip to content
        </a>
        {kiosk ? null : <AppSidebar groups={groups} />}
        <SidebarInset className="min-w-0">
          <Topbar user={user} groups={groups} kiosk={kiosk} />
          <main
            id="main-content"
            className={cn(
              "flex-1 p-4 md:p-6",
              kiosk ? "w-full" : "mx-auto w-full max-w-5xl",
            )}
          >
            <VerifyEmailNotice user={user} />
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </UserContext.Provider>
  );
}
