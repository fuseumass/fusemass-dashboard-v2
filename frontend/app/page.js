"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ApplicationForm from "@/components/ApplicationForm";
import PublicHeader from "@/components/PublicHeader";
import { apiFetch, getToken } from "@/lib/api";

// The home page. Logged-in visitors go to their dashboard. Everyone else gets
// the application form when admins accept applications without an account,
// and the login page (which offers signup) otherwise.
export default function Home() {
  const router = useRouter();
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

  return (
    <>
      <PublicHeader />
      <main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-0 md:pt-10">
        <ApplicationForm mode="public" />
      </main>
    </>
  );
}
