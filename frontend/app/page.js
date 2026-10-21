"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ApplicationForm from "@/components/ApplicationForm";
import Logo from "@/components/Logo";
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
    <main style={{ maxWidth: 900, margin: "0 auto", padding: "2rem 1rem" }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <Logo height={40} />
      </div>
      <ApplicationForm mode="public" />
    </main>
  );
}
