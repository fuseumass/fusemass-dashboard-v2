"use client";

import { useEffect, useState } from "react";
import {
  CardLoading,
  SettingRow,
  SettingsCard,
} from "@/components/SettingsParts";
import { apiFetch } from "@/lib/api";

// Admin setting for the review queue: automatic flagging of suspicious
// applications on submit (nearly empty resume, resume without the
// applicant's name, same phone number or resume on another account).
export default function ReviewSettings() {
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => setSettings(data.settings))
      .catch((err) => setError(err.message));
  }, []);

  async function toggle() {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          autoFlagApplications: !settings.autoFlagApplications,
        }),
      });
      setSettings(data.settings);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsCard title="Application review" error={error}>
      {!settings
        ? <CardLoading rows={1} />
        : <SettingRow
            id="auto-flag"
            title="Flag suspicious applications automatically"
            description="New applications are flagged for reviewers when the resume is nearly empty or doesn't mention the applicant, or when the phone number or resume is already on another account. When this is off, only reviewers flag applications."
            checked={settings.autoFlagApplications}
            disabled={saving}
            onCheckedChange={toggle}
          />}
    </SettingsCard>
  );
}
