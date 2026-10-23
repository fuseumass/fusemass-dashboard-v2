"use client";

import { useEffect, useState } from "react";
import {
  CardLoading,
  Field,
  SettingRow,
  SettingsCard,
} from "@/components/SettingsParts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { cn } from "@/lib/utils";

// ---- Sign-in and applications ------------------------------------------------

export function AuthSettings() {
  const [settings, setSettings] = useState(null);
  const [envAllowed, setEnvAllowed] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setEnvAllowed(data.googleEnvAllowed);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function toggle(key) {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: !settings[key] }),
      });
      setSettings(data.settings);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard title="Authentication" error={error}>
      {!settings
        ? <CardLoading rows={2} />
        : <div className="space-y-4">
            <SettingRow
              id="public-applications"
              title="Accept applications without an account"
              description={
                settings.publicApplications
                  ? "The home page is the application form. Accepted applicants get an email to set a password."
                  : "Applicants sign up and log in before applying."
              }
              checked={settings.publicApplications}
              disabled={saving}
              onCheckedChange={() => toggle("publicApplications")}
            />
            <Separator />
            {envAllowed
              ? <SettingRow
                  id="google-auth"
                  title="Sign in with Google"
                  description={
                    settings.googleAuthEnabled
                      ? "Applicants can sign in with Google."
                      : "The Google button is hidden on the login page."
                  }
                  checked={settings.googleAuthEnabled}
                  disabled={saving}
                  onCheckedChange={() => toggle("googleAuthEnabled")}
                />
              : <p className="text-sm text-muted-foreground">
                  Google sign-in is not configured on the server (missing
                  credentials, or switched off by an environment variable), so
                  there is nothing to switch yet.
                </p>}
          </div>}
    </SettingsCard>
  );
}

// ---- Teams -------------------------------------------------------------------

// Largest team allowed (pending invites count while a team forms).
export function TeamSettings() {
  const [size, setSize] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSize(String(data.settings.teamMaxSize || 4));
        setLoaded(true);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ teamMaxSize: Number(size) }),
      });
      setSize(String(data.settings.teamMaxSize));
      notifySuccess("Team size saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard
      title="Teams"
      error={error}
      onSubmit={save}
      hint="Between 1 and 10 people."
      action={
        <Button type="submit" loading={saving} disabled={!loaded || !size}>
          Save
        </Button>
      }
    >
      {loaded
        ? <Field
            label="Largest team"
            htmlFor="team-max-size"
            hint="Counts everyone on the team plus pending invites."
          >
            <Input
              id="team-max-size"
              type="number"
              min={1}
              max={10}
              value={size}
              onChange={(e) => setSize(e.target.value)}
              className="w-28"
            />
          </Field>
        : <CardLoading rows={1} />}
    </SettingsCard>
  );
}

// ---- Check-in popup ----------------------------------------------------------

// What staff see in large type after each successful check-in.
export function CheckInPopupSettings() {
  const [settings, setSettings] = useState(null);
  const [options, setOptions] = useState({});
  const [fields, setFields] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setOptions(data.checkInPopupFieldOptions || {});
        setFields(data.settings.checkInPopupFields || []);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function save(patchBody, message) {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(patchBody),
      });
      setSettings(data.settings);
      setFields(data.settings.checkInPopupFields || []);
      notifySuccess(message);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function toggleField(key, on) {
    // Keep the order the fields are listed in.
    const next = Object.keys(options).filter((k) =>
      k === key ? on : fields.includes(k),
    );
    setFields(next);
  }

  const enabled = settings?.checkInPopupEnabled;

  return (
    <SettingsCard
      title="Check-in popup"
      error={error}
      hint="Applies to the check-in screen for all staff."
      action={
        <Button
          type="button"
          loading={saving}
          disabled={!settings}
          onClick={() =>
            save({ checkInPopupFields: fields }, "Popup fields saved")
          }
        >
          Save fields
        </Button>
      }
    >
      {!settings
        ? <CardLoading rows={3} />
        : <>
            <SettingRow
              id="checkin-popup"
              title="Show a popup after each check-in"
              description={
                enabled
                  ? "Staff see the details below in large type after a successful scan."
                  : "The check-in screen only shows the result banner."
              }
              checked={enabled}
              disabled={saving}
              onCheckedChange={(on) =>
                save({ checkInPopupEnabled: on }, "Check-in popup updated")
              }
            />
            <div className={cn("space-y-4", !enabled && "opacity-50")}>
              {[
                ["Standard fields", (key) => !key.startsWith("answers.")],
                ["Form questions", (key) => key.startsWith("answers.")],
              ].map(([heading, belongs]) => {
                const entries = Object.entries(options).filter(([key]) =>
                  belongs(key),
                );
                if (!entries.length) return null;
                return (
                  <div key={heading} className="space-y-2">
                    <Separator />
                    <p className="pt-2 text-sm font-medium">{heading}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {entries.map(([key, label]) => (
                        <div key={key} className="flex items-start gap-2">
                          <Checkbox
                            id={`popup-${key}`}
                            checked={fields.includes(key)}
                            onCheckedChange={(v) =>
                              toggleField(key, v === true)
                            }
                            className="mt-0.5"
                          />
                          <Label
                            htmlFor={`popup-${key}`}
                            className="font-normal leading-snug"
                          >
                            {label}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </>}
    </SettingsCard>
  );
}
