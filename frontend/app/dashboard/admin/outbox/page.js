"use client";

import {
  ChevronLeft,
  ChevronRight,
  Mail,
  RefreshCw,
  RotateCcw,
  Send,
  TriangleAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import SearchInput from "@/components/SearchInput";
import StatusDot from "@/components/StatusDot";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "retrying", label: "Retrying" },
  { key: "queued", label: "Queued" },
  { key: "sent", label: "Sent" },
  { key: "cancelled", label: "Cancelled" },
];

// What the button on a row does, by the backend's `resendMode`.
const ACTIONS = {
  retry: "Retry now",
  send_now: "Send now",
  again: "Send again",
  reissue: "Send a new link",
};

// Human names for the template keys the server sends. Unknown keys (custom
// templates) are humanized: "my_template" becomes "My template".
const TEMPLATE_NAMES = {
  application_received: "Application received",
  application_accepted: "Decision: accepted",
  application_rejected: "Decision: rejected",
  application_waitlisted: "Waitlist",
  verify_email: "Email verification",
  account_setup: "Account setup",
  team_invite: "Team invite",
  checked_in: "Check-in confirmation",
  password_reset: "Password reset",
  news: "Announcement",
  test_email: "Test email",
};

function templateName(key) {
  if (!key) return "Email";
  if (TEMPLATE_NAMES[key]) return TEMPLATE_NAMES[key];
  const words = String(key).replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function when(value) {
  return value
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

// The dot and word for a row. A queued email that has already failed once is
// "Retrying"; one the server is sending right now is "Sending".
function statusOf(email) {
  if (email.sending) return { tone: "info", word: "Sending" };
  if (email.status === "sent") return { tone: "success", word: "Sent" };
  if (email.status === "failed") return { tone: "danger", word: "Failed" };
  if (email.status === "cancelled") {
    return { tone: "neutral", word: "Cancelled" };
  }
  if (email.status === "queued" && email.attempts) {
    return { tone: "warning", word: "Retrying" };
  }
  return { tone: "neutral", word: "Queued" };
}

function detailOf(email) {
  if (email.status === "sent") return `Sent ${when(email.sentAt)}`;
  if (email.status === "queued") return `Next try ${when(email.nextAttemptAt)}`;
  if (email.attempts) {
    return `Tried ${email.attempts} time${email.attempts === 1 ? "" : "s"}`;
  }
  return "";
}

// Every email the server sent or tried to send (admins only): failures first
// in mind, with retry, resend and cancel, plus "resend acceptance emails" for
// people accepted before QR codes shipped.
export default function OutboxPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("failed");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [acceptanceOpen, setAcceptanceOpen] = useState(false);
  const [acceptance, setAcceptance] = useState(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (filter !== "all") params.set("status", filter);
    if (query.trim()) params.set("q", query.trim());
    return apiFetch(`/api/admin/outbox?${params}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [filter, query, page]);

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
    else load();
  }, [isAdmin, router, load]);

  if (!isAdmin) return null;

  // Run an action, then refresh the list. Failures (like a resend that fails
  // again) come back as errors with the reason.
  async function run(label, request) {
    setError("");
    setBusy(label);
    try {
      const result = await request();
      await load();
      return result;
    } catch (err) {
      setError(err.message);
      await load();
      return null;
    } finally {
      setBusy("");
    }
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function sendEmail(email, again) {
    const result = await run(email._id, () =>
      apiFetch(`/api/admin/outbox/${email._id}/resend`, {
        method: "POST",
        body: JSON.stringify(again ? { again: true } : {}),
      }),
    );
    if (result) notifySuccess(`Sent to ${email.to}`);
  }

  function rowAction(email) {
    // A copy of something that already went out is confirmed first.
    if (email.status === "sent") setConfirming(email);
    else sendEmail(email, false);
  }

  async function cancel(email) {
    await run(email._id, () =>
      apiFetch(`/api/admin/outbox/${email._id}/cancel`, { method: "POST" }),
    );
  }

  async function retryAll() {
    const result = await run("retry-all", () =>
      apiFetch("/api/admin/outbox/retry-failed", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (result) {
      const queued = `${result.requeued} failed ${result.requeued === 1 ? "email" : "emails"} queued to retry`;
      notifySuccess(
        result.reissued
          ? `${queued}. ${result.reissued} new account setup ${result.reissued === 1 ? "link" : "links"} sent.`
          : queued,
      );
    }
  }

  async function previewAcceptance() {
    setAcceptance(null);
    setAcceptanceOpen(true);
    const result = await run("acceptance", () =>
      apiFetch("/api/admin/outbox/resend-acceptance", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    if (result) setAcceptance(result);
  }

  async function sendAcceptance() {
    const result = await run("acceptance", () =>
      apiFetch("/api/admin/outbox/resend-acceptance", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (result) {
      setAcceptanceOpen(false);
      setAcceptance(null);
      notifySuccess(
        `${result.queued} acceptance emails queued, sent one at a time`,
      );
    }
  }

  const counts = data?.counts;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const columns = [
    {
      accessorKey: "to",
      header: "To",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-medium text-foreground">{row.original.to}</span>
      ),
    },
    {
      id: "email",
      header: "Email",
      enableSorting: false,
      meta: { className: "hidden md:table-cell" },
      cell: ({ row }) => {
        const email = row.original;
        return (
          <div className="flex items-center gap-2">
            <span>{templateName(email.templateKey)}</span>
            {email.category
              ? <Badge variant="outline" className="text-muted-foreground">
                  {email.category}
                </Badge>
              : null}
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      enableSorting: false,
      cell: ({ row }) => {
        const email = row.original;
        const status = statusOf(email);
        const detail = detailOf(email);
        return (
          <div className="min-w-0">
            <StatusDot tone={status.tone}>{status.word}</StatusDot>
            {detail
              ? <div className="text-xs text-muted-foreground tabular-nums">
                  {detail}
                </div>
              : null}
            {email.lastError
              ? <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex max-w-64 items-center gap-1 text-xs text-muted-foreground">
                      <TriangleAlert
                        className="size-3 shrink-0 text-warning"
                        aria-hidden="true"
                      />
                      <span className="truncate">{email.lastError}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-sm break-words">
                    {email.lastError}
                  </TooltipContent>
                </Tooltip>
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
        const email = row.original;
        return (
          <div className="flex items-center justify-end gap-1.5">
            {ACTIONS[email.resendMode]
              ? <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy === email._id}
                  onClick={() => rowAction(email)}
                >
                  <Send aria-hidden="true" />
                  {ACTIONS[email.resendMode]}
                </Button>
              : email.resendNote
                ? <span className="max-w-48 text-xs whitespace-normal text-muted-foreground">
                    {email.resendNote}
                  </span>
                : null}
            {email.status === "queued" && !email.sending
              ? <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy === email._id}
                  onClick={() => cancel(email)}
                >
                  Cancel
                </Button>
              : null}
          </div>
        );
      },
    },
  ];

  const toolbar = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <Tabs
            value={filter}
            onValueChange={(value) => {
              setFilter(value);
              setPage(1);
            }}
          >
            <TabsList aria-label="Status">
              {FILTERS.map((f) => (
                <TabsTrigger key={f.key} value={f.key} className="px-2.5">
                  {f.label}
                  {counts && f.key !== "all" && counts[f.key] !== undefined
                    ? <span className="text-xs text-muted-foreground tabular-nums">
                        {counts[f.key]}
                      </span>
                    : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SearchInput
            label="Search by address"
            placeholder="Search address"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            className="sm:w-48"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCw
              className={cn(refreshing && "animate-spin")}
              aria-hidden="true"
            />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy === "retry-all" || !counts?.failed}
            onClick={retryAll}
          >
            <RotateCcw aria-hidden="true" />
            Retry all failed
          </Button>
        </div>
      </div>
      {error
        ? <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        : null}
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Email outbox"
        description={
          data
            ? `${data.committedLast24h} sent or queued in the last 24 hours, limit ${data.dailyLimit || "none"}.`
            : undefined
        }
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={previewAcceptance}
          >
            <Send aria-hidden="true" />
            Resend acceptance emails
          </Button>
        }
      />

      {data && !data.smtpConfigured
        ? <Alert variant="warning" className="mb-4">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              Email is not configured on the server, so nothing is being sent.
            </AlertDescription>
          </Alert>
        : null}

      <DataTable
        columns={columns}
        data={data ? data.emails : []}
        loading={!data}
        dense
        hidePagination
        pageSize={1000}
        getRowId={(email) => email._id}
        toolbar={toolbar}
        emptyState={
          <EmptyState
            icon={Mail}
            title="No emails here"
            description={
              filter === "failed"
                ? "Nothing has failed."
                : "No emails match this view."
            }
          />
        }
      />

      {data && pages > 1
        ? <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
            <p className="tabular-nums">
              Page {page} of {pages}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="Next page"
                disabled={page >= pages}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        : null}

      <AlertDialog
        open={Boolean(confirming)}
        onOpenChange={(open) => (open ? null : setConfirming(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send another copy?</AlertDialogTitle>
            <AlertDialogDescription>
              This email already went out to {confirming?.to}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => sendEmail(confirming, true)}>
              Send another copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={acceptanceOpen} onOpenChange={setAcceptanceOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resend acceptance emails</DialogTitle>
            <DialogDescription>
              For people accepted before check-in QR codes shipped, or while
              email was down. Anyone the outbox already shows a sent acceptance
              email for is skipped.
            </DialogDescription>
          </DialogHeader>
          {acceptance
            ? <div className="space-y-3 text-sm">
                <p>
                  {acceptance.recipients} of {acceptance.inSegment} accepted
                  applicants would get one
                  {acceptance.skippedAlreadySent
                    ? ` (${acceptance.skippedAlreadySent} already received it)`
                    : ""}
                  .
                </p>
                {acceptance.warnings.map((w) => (
                  <Alert key={w} variant="warning">
                    <AlertDescription>{w}</AlertDescription>
                  </Alert>
                ))}
                {acceptance.overLimit
                  ? <Alert variant="destructive">
                      <AlertDescription>
                        That is over the daily sending limit, so the server will
                        refuse it. Send fewer, or wait.
                      </AlertDescription>
                    </Alert>
                  : null}
              </div>
            : <p className="text-sm text-muted-foreground">
                Checking who would get one
              </p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAcceptanceOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              loading={busy === "acceptance"}
              disabled={
                busy === "acceptance" ||
                !acceptance?.recipients ||
                acceptance?.overLimit
              }
              onClick={sendAcceptance}
            >
              {acceptance ? `Send ${acceptance.recipients}` : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
