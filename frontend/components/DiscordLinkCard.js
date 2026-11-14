"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useFeatures } from "@/lib/features";
import { notifyError, notifySuccess } from "@/lib/notify";

/**
 * Link the signed-in account to Discord, so the Discord bot knows who you are
 * (for example /checkedout lists your hardware). Hidden when the Discord module
 * is off or the Discord app isn't configured.
 * @returns {JSX.Element|null}
 */
export default function DiscordLinkCard() {
  const features = useFeatures();
  const on = features.discord !== false;
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!on) return;
    apiFetch("/api/discord/link")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [on]);

  if (!on || !status || !status.configured) return null;

  async function unlink() {
    setBusy(true);
    try {
      await apiFetch("/api/discord/link", { method: "DELETE" });
      setStatus(await apiFetch("/api/discord/link"));
      notifySuccess("Discord account unlinked");
    } catch (err) {
      notifyError(err, { title: "Couldn't unlink Discord" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Discord account</CardTitle>
        <CardDescription>
          {status.linked
            ? `Linked as ${status.username || "your Discord account"}.`
            : "Link your Discord account so the server's bot can show your checked-out hardware."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild variant={status.linked ? "outline" : "default"}>
          <a href={status.url}>
            {status.linked ? "Link a different account" : "Link Discord"}
          </a>
        </Button>
        {status.linked
          ? <Button variant="ghost" loading={busy} onClick={unlink}>
              Unlink
            </Button>
          : null}
      </CardContent>
    </Card>
  );
}
