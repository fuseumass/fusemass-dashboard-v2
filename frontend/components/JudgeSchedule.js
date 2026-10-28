"use client";

import Link from "next/link";
import DataTable from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/datetime";

export default function JudgeSchedule({ data, skippedOnly = false }) {
  const columns = [
    { accessorKey: "slot", header: "Slot" },
    { accessorKey: "tableNumber", header: "Table" },
    { id: "room", header: "Room", cell: ({ row }) => row.original.room?.name },
    { accessorKey: "name", header: "Project" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <span className="capitalize">{row.original.status}</span>
      ),
    },
  ];
  if (data.slotMinutes && data.judgingOpenedAt) {
    columns.push({
      id: "estimate",
      header: "Estimated start",
      cell: ({ row }) =>
        formatDateTime(
          new Date(data.judgingOpenedAt).getTime() +
            (row.original.slot - 1) * data.slotMinutes * 60000,
        ),
    });
  }
  columns.push({
    id: "action",
    header: "",
    cell: ({ row }) =>
      row.original.status !== "upcoming" && (
        <Button asChild size="sm" variant="outline">
          <Link href={`/dashboard/judging/score?project=${row.original._id}`}>
            {row.original.status === "done" ? "Rescore" : "Judge now"}
            <span className="sr-only"> {row.original.name}</span>
          </Link>
        </Button>
      ),
  });
  return (
    <DataTable
      columns={columns}
      data={skippedOnly ? data.skipped : data.assignments}
      dense
      emptyState={
        <p className="p-4 text-sm text-muted-foreground">
          {skippedOnly ? "No skipped projects" : "No assignments yet"}
        </p>
      }
    />
  );
}
