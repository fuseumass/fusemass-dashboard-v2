"use client";

import { useCallback, useEffect, useState } from "react";
import EmailPreferencesList from "@/components/EmailPreferencesList";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

// The person's own account settings. Today: which optional emails they get.
export default function AccountPage() {
  const user = useUser();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  const load = useCallback(() => {
    setError("");
    return apiFetch("/api/auth/me/email-preferences")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function change(key, value) {
    setBusyKey(key);
    try {
      const next = await apiFetch("/api/auth/me/email-preferences", {
        method: "PUT",
        body: JSON.stringify({ [key]: value }),
      });
      setData(next);
      const label = next.categories.find((c) => c.key === key)?.label;
      notifySuccess(`${label} emails turned ${value ? "on" : "off"}`);
    } catch (err) {
      notifyError(err, { title: "Couldn't save your email preferences" });
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Account" description={user.email} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Email preferences
          </CardTitle>
          <CardDescription>
            Choose which emails you get. Every optional email also has an
            unsubscribe link at the bottom.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {error
            ? <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  {error}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={load}
                  >
                    Try again
                  </Button>
                </AlertDescription>
              </Alert>
            : !data
              ? <div className="space-y-2" aria-hidden="true">
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                  <Skeleton className="h-14 w-full" />
                </div>
              : <EmailPreferencesList
                  categories={data.categories}
                  preferences={data.preferences}
                  busyKey={busyKey}
                  onChange={change}
                />}
        </CardContent>
      </Card>
    </div>
  );
}
