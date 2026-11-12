"use client";

import { History, RefreshCw } from "lucide-react";
import { useState } from "react";
import { CHANNEL_LABELS } from "@/components/communications/ComposeAnnouncement";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import StatusDot from "@/components/StatusDot";
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
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { notifyError, notifySuccess } from "@/lib/notify";

const STATUS = {
  scheduled: { tone: "info", word: "Scheduled" },
  sending: { tone: "info", word: "Sending" },
  sent: { tone: "success", word: "Sent" },
  failed: { tone: "danger", word: "Failed" },
  cancelled: { tone: "neutral", word: "Cancelled" },
};

const DISCORD_WORDS = {
  sent: "posted",
  failed: "failed",
  skipped: "not set up",
  pending: "waiting",
};

function emailLine(a) {
  if (!a.channels.includes("email")) return null;
  if (a.status === "scheduled" || a.status === "cancelled") {
    return a.audienceLabel;
  }
  const s = a.emailStatus;
  const bits = [`${a.emailCounts.queued} queued`, `${s.sent} sent`];
  if (s.failed) bits.push(`${s.failed} failed`);
  if (s.cancelled) bits.push(`${s.cancelled} opted out`);
  if (s.queued) bits.push(`${s.queued} waiting`);
  return `${a.audienceLabel}: ${bits.join(", ")}`;
}

/**
 * Every announcement, newest first, with "Send again" and "Cancel scheduled".
 * @param {object} props
 * @param {Array<object>|null} props.announcements - Null while loading.
 * @param {function} props.onChanged - Reload after an action.
 * @returns {JSX.Element}
 */
export default function AnnouncementHistory({ announcements, onChanged }) {
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null);

  async function act(a, kind) {
    setBusy(a.id);
    try {
      await apiFetch(
        `/api/staff/communications/announcements/${a.id}/${kind}`,
        { method: "POST", body: JSON.stringify({}) },
      );
      notifySuccess(
        kind === "cancel" ? "Scheduled announcement cancelled" : "Sent again",
      );
      await onChanged();
    } catch (err) {
      notifyError(err);
    } finally {
      setBusy("");
      setConfirm(null);
    }
  }

  const columns = [
    {
      id: "what",
      header: "Announcement",
      enableSorting: false,
      cell: ({ row }) => {
        const a = row.original;
        return (
          <div className="min-w-0 max-w-sm space-y-0.5 whitespace-normal">
            <div className="font-medium wrap-anywhere">{a.title}</div>
            <div className="text-xs text-muted-foreground">
              {a.createdBy ? `${a.createdBy.name}, ` : ""}
              <span className="tabular-nums">
                {a.status === "scheduled"
                  ? `for ${formatDateTime(a.scheduledFor)}`
                  : formatDateTime(a.sentAt || a.createdAt)}
              </span>
            </div>
          </div>
        );
      },
    },
    {
      id: "where",
      header: "Channels",
      enableSorting: false,
      meta: { className: "hidden md:table-cell" },
      cell: ({ row }) => {
        const a = row.original;
        const email = emailLine(a);
        return (
          <div className="space-y-0.5 whitespace-normal text-xs text-muted-foreground">
            {email
              ? <div>
                  <span className="text-foreground">Email</span> {email}
                </div>
              : null}
            {a.channels
              .filter((c) => c !== "email")
              .map((c) => {
                const result = a.discord.find((d) => d.channel === c);
                return (
                  <div key={c}>
                    <span className="text-foreground">{CHANNEL_LABELS[c]}</span>{" "}
                    {result ? DISCORD_WORDS[result.status] : "waiting"}
                    {result?.error ? `: ${result.error}` : ""}
                  </div>
                );
              })}
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => {
        const a = row.original;
        const s = STATUS[a.status] || STATUS.sent;
        return (
          <div className="max-w-56 whitespace-normal">
            <StatusDot tone={s.tone}>{s.word}</StatusDot>
            {a.error
              ? <div className="text-xs text-muted-foreground">{a.error}</div>
              : null}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { className: "text-right" },
      cell: ({ row }) => {
        const a = row.original;
        if (a.status === "scheduled") {
          return (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy === a.id}
              onClick={() => setConfirm({ a, kind: "cancel" })}
            >
              Cancel scheduled
            </Button>
          );
        }
        if (a.status === "sending") return null;
        return (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy === a.id}
            onClick={() => setConfirm({ a, kind: "send-again" })}
          >
            <RefreshCw aria-hidden="true" />
            Send again
          </Button>
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={announcements || []}
        loading={!announcements}
        getRowId={(a) => a.id}
        dense
        pageSize={10}
        emptyState={
          <EmptyState
            icon={History}
            title="No announcements yet"
            description="Announcements you send or schedule show up here."
          />
        }
      />
      <AlertDialog
        open={Boolean(confirm)}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "cancel"
                ? "Cancel this scheduled announcement?"
                : "Send this announcement again?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "cancel"
                ? "It won't be sent. You can write it again later."
                : "A new copy goes out now to the same channels and audience. People who already got it get it twice."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busy)}>
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={Boolean(busy)}
              onClick={(e) => {
                e.preventDefault();
                act(confirm.a, confirm.kind);
              }}
            >
              {confirm?.kind === "cancel"
                ? "Cancel announcement"
                : "Send again"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
