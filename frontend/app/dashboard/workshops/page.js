"use client";

import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { formatRange } from "@/lib/datetime";
import { notifySuccess } from "@/lib/notify";

export default function WorkshopsPage() {
  const [items, setItems] = useState([]);
  const [mine, setMine] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [denied, setDenied] = useState(false);
  const [pending, setPending] = useState("");
  const [warning, setWarning] = useState("");
  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const [all, own] = await Promise.all([
        apiFetch("/api/workshops"),
        apiFetch("/api/workshops/mine"),
      ]);
      setItems(all.workshops);
      setMine(own.workshops);
      setDenied(false);
    } catch (err) {
      if (err.status === 403) setDenied(true);
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  async function toggle(item) {
    setPending(item._id);
    setWarning("");
    setError("");
    try {
      const result = await apiFetch(`/api/workshops/${item._id}/signup`, {
        method: item.signedUp ? "DELETE" : "POST",
      });
      setWarning(result.warning || "");
      notifySuccess(
        item.signedUp ? "Signup cancelled" : "Signed up for workshop",
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setPending("");
    }
  }
  const columns = [
    {
      accessorKey: "title",
      header: "Workshop",
      cell: ({ row }) => (
        <div className="max-w-sm space-y-1">
          <p className="font-medium">{row.original.title}</p>
          <p className="text-muted-foreground">{row.original.description}</p>
        </div>
      ),
    },
    { accessorKey: "host", header: "Host" },
    {
      accessorKey: "startsAt",
      header: "Time",
      cell: ({ row }) =>
        formatRange(row.original.startsAt, row.original.endsAt),
    },
    { accessorKey: "location", header: "Place" },
    {
      id: "spots",
      header: "Spots left",
      cell: ({ row }) =>
        row.original.spotsLeft === null
          ? "Unlimited"
          : row.original.spotsLeft === 0
            ? "Full"
            : row.original.spotsLeft,
    },
    {
      id: "signup",
      header: "Signup",
      cell: ({ row }) => (
        <Button
          variant={row.original.signedUp ? "outline" : "default"}
          size="sm"
          loading={pending === row.original._id}
          disabled={
            Boolean(pending) ||
            (!row.original.signedUp && row.original.spotsLeft === 0)
          }
          onClick={() => toggle(row.original)}
        >
          {row.original.signedUp ? "Cancel signup" : "Sign up"}
        </Button>
      ),
    },
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="Workshops" />
      {denied
        ? <p className="text-sm text-muted-foreground">
            Workshops are available once your application is accepted.
          </p>
        : <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {error}{" "}
                  <Button variant="outline" size="sm" onClick={load}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            <div aria-live="polite">
              {warning && (
                <Alert variant="warning">
                  <AlertDescription>{warning}</AlertDescription>
                </Alert>
              )}
            </div>
            <section className="space-y-3" aria-labelledby="my-workshops">
              <h2 id="my-workshops" className="text-base font-semibold">
                My workshops
              </h2>
              <DataTable
                columns={columns}
                data={mine}
                loading={loading}
                emptyState={
                  <EmptyState
                    title="No signups yet"
                    description="Choose a workshop below."
                  />
                }
              />
            </section>
            <section className="space-y-3" aria-labelledby="all-workshops">
              <h2 id="all-workshops" className="text-base font-semibold">
                {mine.length ? "Other workshops" : "All workshops"}
              </h2>
              <DataTable
                columns={columns}
                data={items.filter((item) => !item.signedUp)}
                loading={loading}
                emptyState={
                  <EmptyState
                    title={
                      mine.length
                        ? "No other workshops"
                        : "No published workshops"
                    }
                    description={
                      mine.length
                        ? "You're signed up for every workshop listed."
                        : "Check back when workshops are announced."
                    }
                  />
                }
              />
            </section>
          </>}
    </div>
  );
}
