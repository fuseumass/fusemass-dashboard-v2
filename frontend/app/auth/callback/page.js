"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import AuthShell from "@/components/AuthShell";
import { saveToken } from "@/lib/api";

// Landing page for the Google OAuth redirect. The backend appends ?token=<jwt>;
// we store it and forward the user into the dashboard.
export default function AuthCallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackInner />
    </Suspense>
  );
}

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const token = params.get("token");
    if (token) {
      saveToken(token);
      router.replace("/dashboard");
    } else {
      router.replace("/login?error=google");
    }
  }, [params, router]);

  return (
    <AuthShell title="Signing you in">
      <output className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        One moment.
      </output>
    </AuthShell>
  );
}
