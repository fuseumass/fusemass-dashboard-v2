"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";

export default function DiscordReturnPage() {
  return (
    <Suspense fallback={null}>
      <DiscordReturn />
    </Suspense>
  );
}

// Discord sends people here after they approve linking (?code&state), or with
// ?error when they cancel. The code is redeemed once, then we go home.
function DiscordReturn() {
  const params = useSearchParams();
  const router = useRouter();
  const code = params.get("code") || "";
  const state = params.get("state") || "";
  const cancelled = params.get("error");
  const [error, setError] = useState(
    cancelled
      ? "Linking was cancelled in Discord."
      : code
        ? ""
        : "This link is missing its Discord code.",
  );
  const started = useRef(false);

  useEffect(() => {
    if (!code || cancelled || started.current) return;
    started.current = true;
    apiFetch("/api/discord/callback", {
      method: "POST",
      body: JSON.stringify({ code, state }),
    })
      .then((data) => {
        notifySuccess(`Discord linked as ${data.username || "your account"}`);
        router.replace("/dashboard");
      })
      .catch((err) => setError(err.message));
  }, [code, state, cancelled, router]);

  return (
    <div className="max-w-xl space-y-6">
      <PageHeader title="Link Discord" />
      {error
        ? <Alert variant="destructive">
            <AlertDescription>
              {error}{" "}
              <Button asChild size="sm" variant="outline">
                <Link href="/dashboard">Back to the dashboard</Link>
              </Button>
            </AlertDescription>
          </Alert>
        : <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Linking your Discord account
          </output>}
    </div>
  );
}
