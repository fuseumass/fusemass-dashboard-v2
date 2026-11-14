"use client";

import { Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import EmptyState from "@/components/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { formatDate } from "@/lib/datetime";
import { notifyError, notifySuccess } from "@/lib/notify";

const REASONS = {
  phone: "Same phone number",
  name: "Same name",
  email: "Same Gmail address",
};

// The "Possible duplicates" view of the review page: groups of active
// applications that share a phone number, a full name or a Gmail address.
// `onCompare(id, otherId)` opens the merge dialog; `onOpen(id)` the drawer.
// `reloadKey` changes after a merge or removal so the list is fetched again.
export default function DuplicateSuggestions({
  round,
  reloadKey,
  onCompare,
  onOpen,
}) {
  const [groups, setGroups] = useState(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const [dismissing, setDismissing] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const query = round && round !== "all" ? `?round=${round}` : "";
      const data = await apiFetch(`/api/admin/applications/duplicates${query}`);
      setGroups(data.groups);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    }
  }, [round]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the refetch signal
  useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function dismiss(group, index) {
    setDismissing(index);
    try {
      await apiFetch("/api/admin/applications/duplicates/dismiss", {
        method: "POST",
        body: JSON.stringify({ ids: group.applications.map((a) => a._id) }),
      });
      setGroups((prev) => prev.filter((_, i) => i !== index));
      setTotal((prev) => prev - 1);
      notifySuccess("Marked as not a duplicate");
    } catch (err) {
      notifyError(err, { title: "Couldn't save that" });
    } finally {
      setDismissing(null);
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {error}{" "}
          <Button type="button" variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!groups) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={Copy}
        title="No possible duplicates"
        description="No two active applications share a phone number, a full name or a Gmail address."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground tabular-nums">
        {total} group{total === 1 ? "" : "s"} of applications that may be the
        same person.
      </p>
      {groups.map((group, index) => (
        <section
          key={group.applications.map((a) => a._id).join("-")}
          className="space-y-3 rounded-lg border bg-card p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1.5">
              {group.reasons.map((reason) => (
                <Badge key={reason} variant="info">
                  {REASONS[reason]}
                </Badge>
              ))}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              loading={dismissing === index}
              onClick={() => dismiss(group, index)}
            >
              Not a duplicate
            </Button>
          </div>
          <ul className="divide-y">
            {group.applications.map((a, i) => (
              <li
                key={a._id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <button
                  type="button"
                  className="min-w-0 text-left"
                  onClick={() => onOpen(a._id)}
                >
                  <span className="block font-medium">
                    {a.name || a.applicant?.name}
                  </span>
                  <span className="block break-all text-xs text-muted-foreground">
                    {a.applicant?.email}
                    {a.phone ? `, ${a.phone}` : ""}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                    <ApplicationStatusBadge status={a.status} />
                    <span>
                      {a.round?.name ? `${a.round.name}, ` : ""}
                      applied {formatDate(a.createdAt)}
                    </span>
                  </span>
                </button>
                {i > 0
                  ? <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        onCompare(a._id, group.applications[0]._id)
                      }
                    >
                      Compare and merge
                    </Button>
                  : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
