"use client";

import { useState } from "react";
import { ErrorAlert } from "@/components/SettingsParts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";

// Waitlist mode for one application round: once this many applications in
// the round are accepted, new submissions are waitlisted automatically (and
// the applicant is emailed). Empty means no limit.
export default function WaitlistLimit({ round, onChanged }) {
  const [value, setValue] = useState(
    round.waitlistAfterAccepted ? String(round.waitlistAfterAccepted) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, {
        method: "PATCH",
        body: JSON.stringify({ waitlistAfterAccepted: value.trim() || null }),
      });
      notifySuccess("Waitlist limit saved");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor={`waitlist-${round._id}`}>Waitlist limit</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`waitlist-${round._id}`}
          type="number"
          min={1}
          value={value}
          placeholder="No limit"
          onChange={(e) => setValue(e.target.value)}
          className="w-32"
        />
        <Button type="button" variant="outline" loading={saving} onClick={save}>
          Save limit
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        After this many applications are accepted, new ones are waitlisted and
        the applicant is emailed. Leave empty for no limit.
      </p>
      <ErrorAlert message={error} />
    </div>
  );
}
