"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthShell from "@/components/AuthShell";
import EmailPreferencesList from "@/components/EmailPreferencesList";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";

const OPTIONAL = ["decisions", "account", "event", "announcements"];

// How each category reads in a sentence: "Turn off event update emails".
const NOUNS = {
  decisions: "application decision",
  account: "account setup",
  event: "event update",
  announcements: "announcement",
};

export default function UnsubscribePage() {
  return (
    <Suspense fallback={null}>
      <UnsubscribeInner />
    </Suspense>
  );
}

// Landing page for the link at the bottom of every optional email. Opening it
// changes nothing (a mail scanner that follows the link can't unsubscribe
// anyone): the person turns a category off with a click. No login needed;
// the signed token in the link is the proof. Older "?u=&t=" links from
// announcement emails still work, with a single button.
function UnsubscribeInner() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const legacyUser = params.get("u") || "";
  const legacyToken = params.get("t") || "";

  return (
    <AuthShell
      title="Email preferences"
      footer={
        <Link href="/login" className="font-medium text-link hover:underline">
          Open the dashboard
        </Link>
      }
    >
      {token
        ? <TokenPreferences token={token} />
        : legacyUser && legacyToken
          ? <LegacyUnsubscribe userId={legacyUser} token={legacyToken} />
          : <Alert variant="destructive">
              <AlertDescription>
                This link is incomplete. Use the link from the email, or log in
                to change your email preferences.
              </AlertDescription>
            </Alert>}
    </AuthShell>
  );
}

function TokenPreferences({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    apiFetch("/api/auth/email-preferences/lookup", {
      method: "POST",
      body: JSON.stringify({ token }),
    })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [token]);

  async function save(preferences, key, message) {
    setError("");
    setBusyKey(key);
    try {
      const next = await apiFetch("/api/auth/email-preferences/update", {
        method: "POST",
        body: JSON.stringify({ token, preferences }),
      });
      setData(next);
      setStatus(message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyKey("");
    }
  }

  if (error && !data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="space-y-2" aria-hidden="true">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const category = data.categories.find((c) => c.key === data.category);
  const optional = Boolean(category?.optional);
  const thisOn = optional && data.preferences[data.category] === true;
  const anyOn = OPTIONAL.some((key) => data.preferences[key] === true);
  const label = NOUNS[data.category] || "these";

  function allTo(value) {
    const preferences = {};
    for (const key of OPTIONAL) preferences[key] = value;
    return preferences;
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Settings for{" "}
        <span className="font-medium text-foreground">{data.email}</span>.
        {category ? ` This email was one of your ${label} emails.` : ""}
      </p>
      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
      <div aria-live="polite">
        {status
          ? <Alert variant="success">
              <AlertDescription>{status}</AlertDescription>
            </Alert>
          : null}
      </div>
      {optional
        ? <div className="flex flex-col gap-2">
            <Button
              type="button"
              loading={busyKey === "this"}
              disabled={Boolean(busyKey)}
              onClick={() =>
                save(
                  { [data.category]: !thisOn },
                  "this",
                  thisOn
                    ? `You won't get ${label} emails any more.`
                    : `${category.label} emails are back on.`,
                )
              }
            >
              {thisOn
                ? `Turn off ${label} emails`
                : `Turn ${label} emails back on`}
            </Button>
            <Button
              type="button"
              variant="outline"
              loading={busyKey === "all"}
              disabled={Boolean(busyKey)}
              onClick={() =>
                save(
                  allTo(!anyOn),
                  "all",
                  anyOn
                    ? "You'll only get security emails, such as password resets."
                    : "All optional emails are back on.",
                )
              }
            >
              {anyOn ? "Turn off all optional email" : "Turn all back on"}
            </Button>
          </div>
        : null}
      <EmailPreferencesList
        categories={data.categories}
        preferences={data.preferences}
        highlight={data.category}
        busyKey={busyKey}
        onChange={(key, value) =>
          save(
            { [key]: value },
            key,
            `${data.categories.find((c) => c.key === key).label} emails turned ${value ? "on" : "off"}.`,
          )
        }
      />
    </div>
  );
}

function LegacyUnsubscribe({ userId, token }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleUnsubscribe() {
    setError("");
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ u: userId, t: token }),
      });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Alert variant="success">
        <AlertDescription>
          You are unsubscribed from announcement emails. Log in to choose which
          other emails you get.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        You will stop getting news and reminders sent to everyone.
      </p>
      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
      <Button type="button" loading={submitting} onClick={handleUnsubscribe}>
        {submitting ? "Unsubscribing" : "Unsubscribe from announcements"}
      </Button>
    </div>
  );
}
