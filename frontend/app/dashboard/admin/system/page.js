"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorState from "@/components/ErrorState";
import PageHeader from "@/components/PageHeader";
import SystemSettingRow from "@/components/SystemSettingRow";
import { CardSkeleton, HeaderSkeleton } from "@/components/skeletons";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { API_URL, apiFetch } from "@/lib/api";
import { config } from "@/lib/config";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";

// How long to wait for the server to come back after a restart.
const RESTART_TIMEOUT_MS = 60 * 1000;
const POLL_EVERY_MS = 1500;
// The server stops about half a second after it answers, and can take a few
// seconds to close connections. Until we have seen it go down, a "healthy"
// answer may just be the old process, so we only trust it after this long.
const TRUST_UP_AFTER_MS = 8 * 1000;

// The NEXT_PUBLIC_* variables lib/config.js reads. They are baked into the
// frontend at build time, so they are set in Netlify and need a redeploy.
const FRONTEND_VARS = [
  ["NEXT_PUBLIC_API_URL", config.apiUrl],
  ["NEXT_PUBLIC_ORG_NAME", config.orgName],
  ["NEXT_PUBLIC_LOGO", config.logo],
  ["NEXT_PUBLIC_LOGO_V2", config.logoV2],
  ["NEXT_PUBLIC_BRAND_COLOR", config.brandColor],
  ["NEXT_PUBLIC_EVENT_TIMEZONE", config.eventTimezone],
];

/**
 * @param {number} ms - Time to wait.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the API answers its health check right now.
 * @returns {Promise<boolean>}
 */
async function apiIsUp() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${API_URL}/api/health`, {
      cache: "no-store",
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Admin-only: the server's environment variables, editable from the dashboard.
export default function SystemSettingsPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [drafts, setDrafts] = useState({});
  const [resets, setResets] = useState({});
  const [replacing, setReplacing] = useState({});
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // Keys saved but not yet applied, and whether the server can restart itself.
  const [needsRestart, setNeedsRestart] = useState([]);
  const [restartPrompt, setRestartPrompt] = useState(false);
  // "idle" | "restarting" | "timeout"
  const [phase, setPhase] = useState("idle");
  const unmounted = useRef(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
  }, [isAdmin, router]);

  const load = useCallback(() => {
    setLoadError("");
    apiFetch("/api/admin/system-config")
      .then(setData)
      .catch((err) => setLoadError(err.message));
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const labels = useMemo(() => {
    const map = {};
    for (const s of data?.settings || []) map[s.key] = s.label;
    return map;
  }, [data]);

  // What Save would send: { KEY: "text" | null }.
  const changes = useMemo(() => {
    const out = {};
    for (const s of data?.settings || []) {
      if (!s.editable) continue;
      if (resets[s.key]) {
        out[s.key] = null;
      } else if (drafts[s.key] !== undefined) {
        const draft = drafts[s.key];
        if (s.secret ? draft !== "" : draft !== (s.value ?? "")) {
          out[s.key] = draft;
        }
      }
    }
    return out;
  }, [data, drafts, resets]);
  const changeCount = Object.keys(changes).length;
  const locked = saving || phase !== "idle";

  const on = useMemo(
    () => ({
      change(key, text) {
        setErrors((e) => ({ ...e, [key]: undefined }));
        setDrafts((d) => ({ ...d, [key]: text }));
      },
      reset(key) {
        setDrafts((d) => ({ ...d, [key]: undefined }));
        setResets((r) => ({ ...r, [key]: true }));
      },
      undoReset(key) {
        setResets((r) => ({ ...r, [key]: undefined }));
      },
      startReplace(key) {
        setReplacing((r) => ({ ...r, [key]: true }));
        setDrafts((d) => ({ ...d, [key]: "" }));
      },
      cancelReplace(key) {
        setReplacing((r) => ({ ...r, [key]: undefined }));
        setDrafts((d) => ({ ...d, [key]: undefined }));
        setErrors((e) => ({ ...e, [key]: undefined }));
      },
    }),
    [],
  );

  function discard() {
    setDrafts({});
    setResets({});
    setReplacing({});
    setErrors({});
    setFormError("");
  }

  async function save() {
    setSaving(true);
    setFormError("");
    setErrors({});
    try {
      const res = await apiFetch("/api/admin/system-config", {
        method: "PATCH",
        body: JSON.stringify({ values: changes }),
      });
      setData((d) => ({
        ...d,
        settings: res.settings,
        selfRestart: res.selfRestart,
      }));
      discard();
      notifySuccess(
        res.changed.length
          ? "Technical settings saved"
          : "Nothing needed saving",
      );
      if (res.restartRequired.length) {
        setNeedsRestart((prev) => [
          ...new Set([...prev, ...res.restartRequired]),
        ]);
        if (res.selfRestart) setRestartPrompt(true);
      }
    } catch (err) {
      if (err.data?.errors) {
        setErrors(err.data.errors);
        setFormError("Some values are not valid. Nothing was saved.");
      } else {
        notifyError(err, { title: "Could not save the settings" });
      }
    } finally {
      setSaving(false);
    }
  }

  async function restart() {
    setRestartPrompt(false);
    setPhase("restarting");
    try {
      await apiFetch("/api/admin/system-config/restart", { method: "POST" });
    } catch (err) {
      setPhase("idle");
      if (err.status === 409) {
        setData((d) => ({ ...d, selfRestart: false }));
        return;
      }
      notifyError(err, { title: "Could not restart the dashboard" });
      return;
    }
    setPhase("restarting");
    await waitForServer();
  }

  async function waitForServer() {
    setPhase("restarting");
    const started = Date.now();
    let sawDown = false;
    await sleep(1500);
    while (!unmounted.current) {
      const elapsed = Date.now() - started;
      if (elapsed > RESTART_TIMEOUT_MS) {
        setPhase("timeout");
        return;
      }
      const up = await apiIsUp();
      if (!up) {
        sawDown = true;
      } else if (sawDown || elapsed > TRUST_UP_AFTER_MS) {
        window.location.reload();
        return;
      }
      await sleep(POLL_EVERY_MS);
    }
  }

  if (!isAdmin) return null;

  const groups = (data?.groups || [])
    .map((name) => ({
      name,
      settings: data.settings.filter((s) => s.group === name),
    }))
    .filter((g) => g.settings.length);

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Technical settings"
        description="The server's environment variables, for admins who run the deployment."
      />

      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Please don&apos;t touch</AlertTitle>
        <AlertDescription>
          These settings run the server. A wrong value can take the dashboard
          offline, stop email or lose uploads. Only change them if you know what
          they do, and write down the old value first.
        </AlertDescription>
      </Alert>

      {phase === "restarting"
        ? <Alert variant="info" aria-live="polite">
            <Loader2 className="animate-spin" aria-hidden="true" />
            <AlertTitle>Restarting…</AlertTitle>
            <AlertDescription>
              The dashboard will be back in a few seconds. This page reloads
              when it is.
            </AlertDescription>
          </Alert>
        : null}

      {phase === "timeout"
        ? <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>The dashboard did not come back</AlertTitle>
            <AlertDescription>
              <p>
                It has not answered for a minute. Your changes are saved. Check
                the service on the server, then reload this page.
              </p>
              <Button
                className="mt-2"
                variant="outline"
                size="sm"
                onClick={waitForServer}
              >
                Check again
              </Button>
            </AlertDescription>
          </Alert>
        : null}

      {needsRestart.length > 0 && phase === "idle"
        ? <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>A restart is needed</AlertTitle>
            <AlertDescription>
              <p>
                Your changes are saved. These apply after a restart:{" "}
                {needsRestart.map((k) => labels[k] || k).join(", ")}.
                {data?.selfRestart
                  ? ""
                  : " Restarting from the dashboard is not enabled on this server, so restart the service by hand."}
              </p>
              {data?.selfRestart
                ? <Button
                    className="mt-2"
                    variant="outline"
                    size="sm"
                    onClick={() => setRestartPrompt(true)}
                  >
                    Restart now
                  </Button>
                : null}
            </AlertDescription>
          </Alert>
        : null}

      {formError
        ? <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{formError}</AlertTitle>
          </Alert>
        : null}

      {loadError
        ? <ErrorState
            title="Could not load the settings"
            message={loadError}
            onRetry={load}
          />
        : null}

      {!data && !loadError
        ? <div className="space-y-4">
            <HeaderSkeleton />
            <CardSkeleton lines={4} />
            <CardSkeleton lines={4} />
          </div>
        : null}

      {groups.map((group) => (
        <Card key={group.name}>
          <CardHeader>
            <CardTitle>{group.name}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {group.settings.map((setting) => (
              <SystemSettingRow
                key={setting.key}
                setting={setting}
                draft={drafts[setting.key]}
                resetPending={Boolean(resets[setting.key])}
                replacing={Boolean(replacing[setting.key])}
                error={errors[setting.key]}
                disabled={locked}
                on={on}
              />
            ))}
          </CardContent>
        </Card>
      ))}

      {data
        ? <Card>
            <CardHeader>
              <CardTitle>Frontend (Netlify)</CardTitle>
              <CardDescription>
                These are set in Netlify, not here. Changing one needs a new
                deploy of the frontend.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              {FRONTEND_VARS.map(([name, value]) => (
                <div
                  key={name}
                  className="grid gap-1 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:gap-6"
                >
                  <p className="font-mono text-xs text-muted-foreground md:text-sm">
                    {name}
                  </p>
                  <p className="break-all text-sm">{value || "Not set"}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        : null}

      {changeCount > 0
        ? <section
            className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-4 py-3 md:-mx-6 md:px-6"
            aria-label="Unsaved changes"
          >
            <p className="text-sm" aria-live="polite">
              <span className="tabular-nums">{changeCount}</span> unsaved{" "}
              {changeCount === 1 ? "change" : "changes"}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" disabled={locked} onClick={discard}>
                Discard
              </Button>
              <Button loading={saving} disabled={locked} onClick={save}>
                Save changes
              </Button>
            </div>
          </section>
        : null}

      <AlertDialog open={restartPrompt} onOpenChange={setRestartPrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes are saved, but these only apply after a restart:{" "}
              {needsRestart.map((k) => labels[k] || k).join(", ")}. The
              dashboard will restart to apply them and will be back in a few
              seconds. Anyone using it will see an error until then.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={restart}>Restart now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
