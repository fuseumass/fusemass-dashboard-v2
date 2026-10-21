"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import VerifyEmailNotice from "@/components/VerifyEmailNotice";
import { apiFetch, getToken } from "@/lib/api";
import { UserContext } from "@/lib/userContext";

// Full-height wrapper for the states where there is no dashboard to show yet.
function CenteredNotice({ children }) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
      }}
    >
      {children}
    </div>
  );
}

// Shared shell for every logged-in page: auth guard + sidebar. Fetches the
// current user once and shares it via context so child pages don't refetch.
export default function DashboardLayout({ children }) {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return (
      <CenteredNotice>
        <p className="muted">Loading…</p>
      </CenteredNotice>
    );
  }

  if (error) {
    return (
      <CenteredNotice>
        <div className="alert-error" role="alert">
          {error}
        </div>
      </CenteredNotice>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <UserContext.Provider value={user}>
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <Sidebar user={user} />
        <main
          style={{ flex: 1, padding: "2rem", maxWidth: 900, width: "100%" }}
        >
          <VerifyEmailNotice user={user} />
          {children}
        </main>
      </div>
    </UserContext.Provider>
  );
}
