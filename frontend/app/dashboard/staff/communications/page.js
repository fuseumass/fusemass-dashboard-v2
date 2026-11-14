"use client";

import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import AnnouncementHistory from "@/components/communications/AnnouncementHistory";
import ComposeAnnouncement, {
  CHANNEL_LABELS,
} from "@/components/communications/ComposeAnnouncement";
import DiscordMentions from "@/components/communications/DiscordMentions";
import WorkshopAutomations from "@/components/communications/WorkshopAutomations";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import StatusDot from "@/components/StatusDot";
import { CardSkeleton } from "@/components/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiFetch } from "@/lib/api";
import { formatDate, formatTime } from "@/lib/datetime";
import { useUser } from "@/lib/userContext";

const STAFF = ["moderator", "admin"];

// "Hackathon Playbook reminder at 8:45 PM to 12 people + Discord".
function describeNext(item) {
  const channels = item.channels.map((c) =>
    c === "email" ? "email" : CHANNEL_LABELS[c],
  );
  const people =
    item.recipients !== undefined
      ? ` to ${item.recipients} ${item.recipients === 1 ? "person" : "people"}`
      : item.audienceLabel
        ? ` to ${item.audienceLabel}`
        : "";
  return `${item.label}${people} (${channels.join(" + ")})`;
}

// Announcements to email and Discord, their history, and the workshop
// automations (moderators and admins; admins change the automations).
export default function CommunicationsPage() {
  const user = useUser();
  const router = useRouter();
  const allowed = STAFF.includes(user.role);
  const [data, setData] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("compose");

  const loadHistory = useCallback(
    () =>
      apiFetch("/api/staff/communications/announcements?limit=100")
        .then((res) => setHistory(res.announcements))
        .catch((err) => setError(err.message)),
    [],
  );
  const load = useCallback(() => {
    setError("");
    return Promise.all([
      apiFetch("/api/staff/communications").then(setData),
      loadHistory(),
    ]).catch((err) => setError(err.message));
  }, [loadHistory]);

  useEffect(() => {
    if (!allowed) router.replace("/dashboard");
    else load();
  }, [allowed, router, load]);

  if (!allowed) return null;

  const channels = data?.channels;
  const scheduled = (history || []).filter(
    (a) => a.status === "scheduled",
  ).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Communications"
        description={
          channels
            ? [
                channels.email ? "Email ready" : "Email not set up",
                channels.discord_announcements
                  ? "Discord announcements ready"
                  : "Discord announcements not set up",
                channels.discord_workshops
                  ? "Discord workshops ready"
                  : "Discord workshops not set up",
              ].join(" · ")
            : null
        }
      />

      {error
        ? <Alert variant="destructive">
            <AlertDescription className="flex flex-wrap items-center gap-3">
              {error}
              <Button type="button" size="sm" variant="outline" onClick={load}>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        : null}

      {data ? <SetupNotice data={data} /> : null}

      {!data
        ? error
          ? null
          : <div className="grid gap-4 lg:grid-cols-2">
              <CardSkeleton lines={6} />
              <CardSkeleton lines={4} />
            </div>
        : <>
            <NextUp items={data.next} workshopsOn={channels.workshops} />
            <Tabs value={tab} onValueChange={setTab}>
              <div className="max-w-full overflow-x-auto">
                <TabsList aria-label="Communications">
                  <TabsTrigger value="compose">Compose</TabsTrigger>
                  <TabsTrigger value="history">
                    History
                    {scheduled
                      ? <span className="text-xs text-muted-foreground tabular-nums">
                          {scheduled} scheduled
                        </span>
                      : null}
                  </TabsTrigger>
                  <TabsTrigger value="automations">Automations</TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value="compose" className="mt-4">
                <div className="space-y-4">
                  <ComposeAnnouncement
                    channels={channels}
                    audiences={data.audiences}
                    tags={data.settings.discordTags}
                    workshops={data.workshops}
                    webhookEnv={data.webhookEnv}
                    onSent={() => {
                      load();
                    }}
                  />
                  <div className="max-w-3xl">
                    <DiscordMentions
                      tags={data.settings.discordTags}
                      canEdit={data.canEditSettings}
                      onSaved={(res) =>
                        setData((d) => ({
                          ...d,
                          settings: res.settings,
                          next: res.next,
                        }))
                      }
                    />
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="history" className="mt-4">
                <AnnouncementHistory announcements={history} onChanged={load} />
              </TabsContent>
              <TabsContent value="automations" className="mt-4">
                <div className="max-w-3xl">
                  <WorkshopAutomations
                    settings={data.settings}
                    channels={channels}
                    canEdit={data.canEditSettings}
                    onSaved={(res) =>
                      setData((d) => ({
                        ...d,
                        settings: res.settings,
                        next: res.next,
                      }))
                    }
                  />
                </div>
              </TabsContent>
            </Tabs>
          </>}
    </div>
  );
}

function NextUp({ items, workshopsOn }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-base font-semibold">Next up</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0
          ? <EmptyState
              icon={CalendarClock}
              className="py-4"
              title="Nothing scheduled"
              description={
                workshopsOn
                  ? "Scheduled announcements and workshop reminders for the next two days show here."
                  : "Scheduled announcements show here. Workshop automations are off with the workshops module."
              }
            />
          : <ul className="divide-y divide-border">
              {items.slice(0, 8).map((item) => (
                <li
                  key={`${item.kind}-${item.scope || ""}-${item.offset || ""}-${item.id || item.workshop || ""}-${item.label}-${item.at}`}
                  className="grid gap-0.5 py-2 text-sm first:pt-0 last:pb-0 sm:flex sm:items-baseline sm:gap-3"
                >
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums sm:w-36">
                    {formatDate(item.at)},{" "}
                    {formatTime(item.at, { zone: "never" })}
                  </span>
                  <span className="min-w-0 flex-1 wrap-break-word">
                    {describeNext(item)}
                  </span>
                  <StatusDot
                    tone={item.kind === "announcement" ? "info" : "brand"}
                    className="hidden sm:inline-flex"
                  >
                    {item.kind === "announcement"
                      ? "Announcement"
                      : item.kind === "digest"
                        ? "Digest"
                        : "Reminder"}
                  </StatusDot>
                </li>
              ))}
            </ul>}
      </CardContent>
    </Card>
  );
}

// Which Discord channels have no webhook yet, and exactly how to add one.
function SetupNotice({ data }) {
  const missing = Object.keys(data.webhookEnv || {}).filter(
    (key) => !data.channels[key],
  );
  if (!missing.length) return null;
  const isAdmin = data.canEditSettings;
  return (
    <Alert>
      <AlertDescription className="space-y-1">
        {missing.map((key) => (
          <p key={key}>
            {CHANNEL_LABELS[key]} isn't set up.{" "}
            {isAdmin
              ? <>
                  Add the webhook URL as{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {data.webhookEnv[key]}
                  </code>{" "}
                  in{" "}
                  <Link
                    href="/dashboard/admin/system"
                    className="text-link underline underline-offset-2"
                  >
                    Technical settings
                  </Link>
                  .
                </>
              : <>
                  An admin needs to add{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    {data.webhookEnv[key]}
                  </code>{" "}
                  in Technical settings.
                </>}
          </p>
        ))}
      </AlertDescription>
    </Alert>
  );
}
