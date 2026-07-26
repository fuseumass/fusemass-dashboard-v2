"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import { apiFetch, clearToken, getToken } from "@/lib/api";
import { UserContext } from "@/lib/userContext";

// Shared shell for every logged-in page: auth guard + sidebar. Fetches the
// current user once and shares it via context so child pages don't refetch.
export default function DashboardLayout({ children }) {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    apiFetch("/api/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => {
        clearToken();
        router.replace("/login");
      })
      .finally(() => setLoading(false));
  }, [router]);

  if (loading || !user) {
    return (
      <div
        style={{
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <UserContext.Provider value={user}>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar user={user} />
        <main
          style={{ flex: 1, padding: "2rem", maxWidth: 900, width: "100%" }}
        >
          {children}
        </main>
      </div>
    </UserContext.Provider>
  );
}
