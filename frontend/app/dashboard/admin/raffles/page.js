"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useUser } from "@/lib/userContext";

export default function RafflesPage() {
  const user = useUser();
  const [draws, setDraws] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setError("");
      setDraws((await apiFetch("/api/admin/raffles")).draws);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (user.role === "admin") load();
  }, [load, user.role]);
  if (user.role !== "admin") return <p>Admin access required.</p>;
  return (
    <div className="space-y-6">
      <PageHeader title="Raffles" />
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
        data={draws}
        columns={[
          {
            id: "workshop",
            header: "Workshop",
            cell: ({ row }) =>
              row.original.workshop
                ? <Link
                    className="text-link underline"
                    href={`/dashboard/organize/${row.original.workshop._id}`}
                  >
                    {row.original.workshop.title}
                  </Link>
                : "Deleted workshop",
          },
          { accessorKey: "prize", header: "Prize" },
          {
            accessorKey: "createdAt",
            header: "Drawn at",
            cell: ({ row }) => formatDateTime(row.original.createdAt),
          },
          {
            id: "winners",
            header: "Winners",
            cell: ({ row }) =>
              row.original.winners.map((winner) => (
                <p key={winner._id}>
                  {winner.user?.name || "Deleted user"} ({winner.user?.email}) ·{" "}
                  {winner.noShow
                    ? "No-show"
                    : winner.claimed
                      ? "Claimed"
                      : "Awaiting collection"}
                </p>
              )),
          },
        ]}
        emptyState={
          <EmptyState
            title="No draws yet"
            description="Workshop raffle draws will appear here."
          />
        }
      />
    </div>
  );
}
