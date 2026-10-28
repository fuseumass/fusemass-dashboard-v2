"use client";

import { useEffect, useState } from "react";
import { CardLoading, SettingsCard } from "@/components/SettingsParts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";

function localValue(value, zone) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const fields = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

function instant(value, zone) {
  const wall = Date.parse(`${value}Z`);
  let guess = wall;
  for (let i = 0; i < 4; i += 1) {
    const offset = Date.parse(`${localValue(guess, zone)}Z`) - guess;
    guess = wall - offset;
  }
  if (localValue(guess, zone) !== value) {
    throw new Error(
      "This time does not exist in the event time zone. Choose another time.",
    );
  }
  return new Date(guess).toISOString();
}

/** @param {object} props - No options. @returns {object} Hardware settings form. */
export default function HardwareSettings() {
  const [zone, setZone] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setZone(data.eventTimezone);
        setValue(
          localValue(data.settings.hardwareReturnBy, data.eventTimezone),
        );
      })
      .catch((err) => setError(err.message));
  }, []);
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          hardwareReturnBy: value ? instant(value, zone) : null,
        }),
      });
      notifySuccess("Hardware return deadline saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsCard
      title="Hardware"
      error={error}
      description="New loans use this return deadline when staff leave the deadline blank."
    >
      {!zone
        ? <CardLoading rows={1} />
        : <form onSubmit={save} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="hardware-return-by">
                Return hardware by ({zone})
              </Label>
              <Input
                id="hardware-return-by"
                type="datetime-local"
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave empty and emails say "the last day of the event".
              </p>
            </div>
            <Button type="submit" loading={saving}>
              Save deadline
            </Button>
          </form>}
    </SettingsCard>
  );
}
