"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { formatRange } from "@/lib/datetime";

export default function OrganizePage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setItems((await apiFetch("/api/workshops/manageable")).workshops);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="space-y-6">
      <PageHeader title="Organize workshops" />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="outline" onClick={load}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <DataTable
        loading={loading}
        data={items}
        columns={[
          {
            accessorKey: "title",
            header: "Workshop",
            cell: ({ row }) => (
              <Link
                className="text-link underline"
                href={`/dashboard/organize/${row.original._id}`}
              >
                {row.original.title}
              </Link>
            ),
          },
          { accessorKey: "location", header: "Location" },
          {
            id: "time",
            header: "Time",
            cell: ({ row }) =>
              formatRange(row.original.startsAt, row.original.endsAt),
          },
        ]}
        emptyState={
          <EmptyState
            title="No workshops to manage"
            description="Assigned workshops will appear here."
          />
        }
      />
    </div>
  );
}
