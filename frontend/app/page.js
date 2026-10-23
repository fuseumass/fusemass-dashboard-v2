"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ApplicationForm from "@/components/ApplicationForm";
import { API_URL, apiFetch, getToken } from "@/lib/api";
import { useBranding } from "@/lib/branding";

// The home page. Logged-in visitors go to their dashboard. Everyone else gets
// the application form when admins accept applications without an account,
// and the login page (which offers signup) otherwise.
export default function Home() {
  const router = useRouter();
  const branding = useBranding();
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (getToken()) {
      router.replace("/dashboard");
      return;
    }
    apiFetch("/api/meta/config")
      .then((data) => {
        if (data.publicApplications) {
          setShowForm(true);
        } else {
          router.replace("/login");
        }
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  if (!showForm) {
    return null;
  }

  const name = branding.orgName || "Dashboard";
  const logo = branding.logoUrl
    ? branding.logoUrl.startsWith("/")
      ? `${API_URL}${branding.logoUrl}`
      : branding.logoUrl
    : "";

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-0 md:pt-10">
      <div className="mb-8 flex items-center gap-2.5">
        {logo
          ? // biome-ignore lint/performance/noImgElement: admin-uploaded logo served by the API
            <img
              src={logo}
              alt=""
              className="size-8 shrink-0 rounded-md object-contain"
            />
          : <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand text-sm font-semibold text-brand-foreground"
            >
              {name.charAt(0).toUpperCase()}
            </span>}
        <span className="text-base font-semibold tracking-tight">{name}</span>
      </div>
      <ApplicationForm mode="public" />
    </main>
  );
}
