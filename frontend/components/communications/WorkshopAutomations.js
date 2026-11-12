"use client";

import { Plus, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { getEventTimeZone } from "@/lib/datetime";
import { notifySuccess } from "@/lib/notify";

// Copy the server's settings into editable strings.
function toDraft(s) {
  return {
    allDiscord: s.reminderAll.discord,
    allEmail: s.reminderAll.email,
    allOffsets: s.reminderAll.offsets,
    signedEmail: s.reminderSignedUp.email,
    signedDiscord: s.reminderSignedUp.discord,
    signedOffsets: s.reminderSignedUp.offsets,
    mentionOn: s.workshopMention.enabled,
    mentionTag: s.workshopMention.tag,
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

// "2 hours", "45 minutes".
function lead(minutes) {
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
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
    const hours = whole(draft.digestHours, 1, 72);
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
          reminderAll: {
            discord: draft.allDiscord,
            email: draft.allEmail,
            offsets: draft.allOffsets,
          },
          reminderSignedUp: {
            email: draft.signedEmail,
            discord: draft.signedDiscord,
            offsets: draft.signedOffsets,
          },
          workshopMention: {
            enabled: draft.mentionOn,
            tag: draft.mentionTag,
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
                ? "Checked every minute. Each send happens once per person and workshop, and again if the workshop moves."
                : "Only admins can change these."
              : "The workshops module is off, so none of these run."}
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          <Row
            id="auto-all-discord"
            title="Announce each workshop in Discord workshops"
            hint={
              noDiscord ||
              "Title, time, room, host, spots left and a sign-up link. Workshops that start together share one post."
            }
            on={draft.allDiscord}
            onToggle={(v) => set("allDiscord", v)}
            disabled={disabled}
          />
          <Row
            id="auto-all-email"
            title="Email each workshop to all accepted participants"
            hint={
              noEmail ||
              "One email per person, even when several workshops start together. People who turned off event emails are skipped."
            }
            on={draft.allEmail}
            onToggle={(v) => set("allEmail", v)}
            disabled={disabled}
          />
          <div className="space-y-2 py-3">
            <p className="text-sm font-medium">
              Announce this long before a workshop starts
            </p>
            <Offsets
              id="auto-all-offsets"
              offsets={draft.allOffsets}
              onChange={(v) => set("allOffsets", v)}
              disabled={disabled}
            />
          </div>
          <Row
            id="auto-signed-email"
            title="Remind the people signed up by email"
            hint={
              noEmail ||
              "The last reminder, 5 minutes before or less, says the workshop is starting now in its room."
            }
            on={draft.signedEmail}
            onToggle={(v) => set("signedEmail", v)}
            disabled={disabled}
          />
          <Row
            id="auto-signed-discord"
            title="Also post these reminders in Discord workshops"
            hint={noDiscord || "Off by default. Posts at the same times."}
            on={draft.signedDiscord}
            onToggle={(v) => set("signedDiscord", v)}
            disabled={disabled}
          />
          <div className="space-y-2 py-3">
            <p className="text-sm font-medium">
              Remind people signed up this long before
            </p>
            <Offsets
              id="auto-signed-offsets"
              offsets={draft.signedOffsets}
              onChange={(v) => set("signedOffsets", v)}
              disabled={disabled}
            />
          </div>
          <Row
            id="auto-mention"
            title="Mention a Discord role in automated workshop posts"
            hint="Announcements, reminders, the daily list and new or moved workshops. Off by default."
            on={draft.mentionOn}
            onToggle={(v) => set("mentionOn", v)}
            disabled={disabled}
          >
            <div className="space-y-1">
              <Label htmlFor="auto-mention-tag" className="text-xs">
                Mention
              </Label>
              <Select
                value={draft.mentionTag}
                onValueChange={(v) => set("mentionTag", v)}
                disabled={disabled}
              >
                <SelectTrigger id="auto-mention-tag" className="w-56">
                  <SelectValue placeholder="Pick a role" />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "everyone",
                    "here",
                    ...settings.discordTags.map((t) => t.label),
                  ].map((label) => (
                    <SelectItem key={label} value={label}>
                      @{label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              "The same list, to accepted participants who haven't opted out of announcements. At most once a day."
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

// An editable list of "minutes before start" values.
function Offsets({ id, offsets, onChange, disabled }) {
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");

  function add() {
    const n = whole(text, 1, 2880);
    if (n === null) {
      setProblem("Use a whole number of minutes from 1 to 2880.");
    } else if (offsets.includes(n)) {
      setProblem("That time is already in the list.");
    } else if (offsets.length >= 6) {
      setProblem("Use at most 6 times.");
    } else {
      onChange([...offsets, n].sort((a, b) => b - a));
      setText("");
      setProblem("");
    }
  }

  return (
    <div className="space-y-2">
      <ul className="flex flex-wrap gap-1.5" aria-label="Times before start">
        {offsets.length === 0
          ? <li className="text-sm text-muted-foreground">
              None. Nothing is sent.
            </li>
          : offsets.map((minutes) => (
              <li
                key={minutes}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-sm tabular-nums"
              >
                {lead(minutes)}
                <button
                  type="button"
                  className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                  aria-label={`Remove ${lead(minutes)}`}
                  disabled={disabled}
                  onClick={() => onChange(offsets.filter((m) => m !== minutes))}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <NumberField
          id={`${id}-add`}
          label="Add minutes before start"
          value={text}
          error={problem}
          onChange={(v) => {
            setText(v);
            setProblem("");
          }}
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={add}
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </div>
    </div>
  );
}
