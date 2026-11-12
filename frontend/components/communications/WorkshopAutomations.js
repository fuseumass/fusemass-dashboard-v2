"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { getEventTimeZone } from "@/lib/datetime";
import { notifySuccess } from "@/lib/notify";

// Copy the server's settings into editable strings.
function toDraft(s) {
  return {
    reminderEmailOn: s.reminderEmail.enabled,
    reminderEmailMin: String(s.reminderEmail.minutesBefore),
    reminderDiscordOn: s.reminderDiscord.enabled,
    reminderDiscordMin: String(s.reminderDiscord.minutesBefore),
    digestDiscordOn: s.digestDiscord.enabled,
    digestTime: s.digestDiscord.time,
    digestHours: String(s.digestDiscord.windowHours),
    digestEmailOn: s.digestEmail.enabled,
    updatesOn: s.updatesDiscord.enabled,
  };
}

function whole(value, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Settings for the workshop automations (admins edit, moderators read).
 * @param {object} props
 * @param {object} props.settings - From the API.
 * @param {object} props.channels - Which channels exist.
 * @param {boolean} props.canEdit - Admin.
 * @param {function} props.onSaved - ({ settings, next }) => void.
 * @returns {JSX.Element}
 */
export default function WorkshopAutomations({
  settings,
  channels,
  canEdit,
  onSaved,
}) {
  const [draft, setDraft] = useState(() => toDraft(settings));
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(toDraft(settings));
  }, [settings]);

  function set(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    const next = {};
    const emailMin = whole(draft.reminderEmailMin, 5, 1440);
    const discordMin = whole(draft.reminderDiscordMin, 5, 1440);
    const hours = whole(draft.digestHours, 1, 72);
    if (emailMin === null) next.reminderEmailMin = "Use 5 to 1440 minutes.";
    if (discordMin === null) next.reminderDiscordMin = "Use 5 to 1440 minutes.";
    if (hours === null) next.digestHours = "Use 1 to 72 hours.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.digestTime)) {
      next.digestTime = "Pick a time.";
    }
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    try {
      const data = await apiFetch("/api/staff/communications/settings", {
        method: "PATCH",
        body: JSON.stringify({
          reminderEmail: {
            enabled: draft.reminderEmailOn,
            minutesBefore: emailMin,
          },
          reminderDiscord: {
            enabled: draft.reminderDiscordOn,
            minutesBefore: discordMin,
          },
          digestDiscord: {
            enabled: draft.digestDiscordOn,
            time: draft.digestTime,
            windowHours: hours,
          },
          digestEmail: { enabled: draft.digestEmailOn },
          updatesDiscord: { enabled: draft.updatesOn },
        }),
      });
      notifySuccess("Automation settings saved");
      onSaved(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const noEmail = channels.email
    ? ""
    : "Email isn't set up, so this is paused.";
  const noDiscord = channels.discord_workshops
    ? ""
    : "No workshops webhook yet, so this is paused.";
  const zone = getEventTimeZone();
  const disabled = !canEdit || saving;

  return (
    <Card>
      <form onSubmit={save} noValidate>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Workshop automations
          </CardTitle>
          <CardDescription>
            {channels.workshops
              ? canEdit
                ? "Run every minute. Each reminder goes out once per person."
                : "Only admins can change these."
              : "The workshops module is off, so none of these run."}
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <Row
            id="auto-reminder-email"
            title="Reminder email to everyone signed up"
            hint={noEmail || "Time, room, host and a link to the workshop."}
            on={draft.reminderEmailOn}
            onToggle={(v) => set("reminderEmailOn", v)}
            disabled={disabled}
          >
            <NumberField
              id="auto-reminder-email-min"
              label="Minutes before start"
              value={draft.reminderEmailMin}
              error={errors.reminderEmailMin}
              onChange={(v) => set("reminderEmailMin", v)}
              disabled={disabled}
            />
          </Row>
          <Row
            id="auto-reminder-discord"
            title="Starting soon post in Discord workshops"
            hint={noDiscord || "Title, time, room, host and spots left."}
            on={draft.reminderDiscordOn}
            onToggle={(v) => set("reminderDiscordOn", v)}
            disabled={disabled}
          >
            <NumberField
              id="auto-reminder-discord-min"
              label="Minutes before start"
              value={draft.reminderDiscordMin}
              error={errors.reminderDiscordMin}
              onChange={(v) => set("reminderDiscordMin", v)}
              disabled={disabled}
            />
          </Row>
          <Row
            id="auto-digest-discord"
            title="Daily sign-up post in Discord workshops"
            hint={
              noDiscord ||
              "Upcoming published workshops with open spots and a sign-up link."
            }
            on={draft.digestDiscordOn}
            onToggle={(v) => set("digestDiscordOn", v)}
            disabled={disabled}
          >
            <div className="flex flex-wrap gap-3">
              <div className="space-y-1">
                <Label htmlFor="auto-digest-time" className="text-xs">
                  Time{zone ? ` (${zone})` : ""}
                </Label>
                <Input
                  id="auto-digest-time"
                  type="time"
                  className="w-32"
                  value={draft.digestTime}
                  disabled={disabled}
                  aria-invalid={Boolean(errors.digestTime) || undefined}
                  onChange={(e) => set("digestTime", e.target.value)}
                />
                {errors.digestTime
                  ? <p className="text-xs text-destructive">
                      {errors.digestTime}
                    </p>
                  : null}
              </div>
              <NumberField
                id="auto-digest-hours"
                label="Hours ahead"
                value={draft.digestHours}
                error={errors.digestHours}
                onChange={(v) => set("digestHours", v)}
                disabled={disabled}
              />
            </div>
          </Row>
          <Row
            id="auto-digest-email"
            title="Daily sign-up email"
            hint={
              noEmail ||
              "The same list, to accepted participants who opted in to announcements. At most once a day."
            }
            on={draft.digestEmailOn}
            onToggle={(v) => set("digestEmailOn", v)}
            disabled={disabled}
          />
          <Row
            id="auto-updates"
            title="Post new and moved workshops"
            hint={
              noDiscord ||
              "When a workshop is published, or its time or room changes."
            }
            on={draft.updatesOn}
            onToggle={(v) => set("updatesOn", v)}
            disabled={disabled}
          />
          {error
            ? <Alert variant="destructive" className="mt-3">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            : null}
        </CardContent>
        {canEdit
          ? <CardFooter className="justify-end">
              <Button type="submit" loading={saving}>
                Save automations
              </Button>
            </CardFooter>
          : null}
      </form>
    </Card>
  );
}

function Row({ id, title, hint, on, onToggle, disabled, children }) {
  return (
    <div className="space-y-3 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {title}
          </Label>
          <p id={`${id}-hint`} className="text-[0.8rem] text-muted-foreground">
            {hint}
          </p>
        </div>
        <Switch
          id={id}
          checked={on}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onCheckedChange={onToggle}
        />
      </div>
      {on && children ? children : null}
    </div>
  );
}

function NumberField({ id, label, value, error, onChange, disabled }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        className="w-28 tabular-nums"
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(error) || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
