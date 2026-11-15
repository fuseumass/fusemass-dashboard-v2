"use client";

import Link from "next/link";
import DataTable from "@/components/DataTable";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDateTime } from "@/lib/datetime";

export default function JudgeSchedule({ data, skippedOnly = false }) {
  const statusLabel = {
    done: "Judged",
    skipped: "Skipped",
    current: "Next",
    upcoming: "Upcoming",
  };
  const columns = [
    {
      id: "judged",
      header: "Judged",
      // Read-only tick so judges can see at a glance what they have scored.
      cell: ({ row }) => (
        <Checkbox
          checked={row.original.status === "done"}
          disabled
          aria-label={`${row.original.name}: ${row.original.status === "done" ? "judged" : "not judged yet"}`}
        />
      ),
    },
    { accessorKey: "slot", header: "Slot" },
    { accessorKey: "tableNumber", header: "Table" },
    { id: "room", header: "Room", cell: ({ row }) => row.original.room?.name },
    { accessorKey: "name", header: "Project" },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <span>{statusLabel[row.original.status] || row.original.status}</span>
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
    // Judged projects can be opened again to change the saved scores.
    cell: ({ row }) => (
      <Button
        asChild
        size="sm"
        variant={row.original.status === "done" ? "ghost" : "outline"}
        className="pointer-coarse:h-10"
      >
        <Link href={`/dashboard/judging/score?project=${row.original._id}`}>
          {row.original.status === "done" ? "Rejudge" : "Judge now"}
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
