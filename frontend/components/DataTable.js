"use client";

import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
} from "lucide-react";
import { useState } from "react";
import { TableRowsSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const PAGE_SIZES = [10, 25, 50, 100];

// One table for every admin list (TanStack Table v8 under shadcn's Table).
//
// Client mode (default): pass `data` and the table sorts and pages it itself.
// Server mode: pass `pageCount` (or `rowCount`) and the table stops slicing;
//   you control the state and refetch when it changes:
//     pagination + onPaginationChange   { pageIndex, pageSize }
//     sorting + onSortingChange         [{ id, desc }]
//   Filtering is yours too: put the search box and filters in `toolbar` and
//   fetch with them. The table only draws what it is given.
//
// Columns are standard TanStack column defs. Useful extras:
//   meta: { className }  classes for that column's header and cells
//   enableSorting: false to turn the sort button off for a column
//
// Pass `onRowClick` to make rows clickable; rows then take focus and open on
// Enter. Keep a real button or link in the row too, for touch and screen
// readers that skip row semantics.
export default function DataTable({
  columns,
  data,
  loading = false,
  emptyState = null,
  toolbar = null,
  onRowClick,
  getRowId,
  pageSize: initialPageSize = 25,
  hidePagination = false,
  pageCount,
  rowCount,
  pagination: paginationProp,
  onPaginationChange,
  sorting: sortingProp,
  onSortingChange,
  className,
}) {
  const [sortingState, setSortingState] = useState([]);
  const [paginationState, setPaginationState] = useState({
    pageIndex: 0,
    pageSize: initialPageSize,
  });

  const serverPaging = pageCount != null || rowCount != null;
  const serverSorting = Boolean(onSortingChange);
  const sorting = sortingProp ?? sortingState;
  const pagination = paginationProp ?? paginationState;

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, pagination },
    onSortingChange: onSortingChange ?? setSortingState,
    onPaginationChange: onPaginationChange ?? setPaginationState,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: serverSorting ? undefined : getSortedRowModel(),
    getPaginationRowModel: serverPaging ? undefined : getPaginationRowModel(),
    manualSorting: serverSorting,
    manualPagination: serverPaging,
    pageCount: serverPaging
      ? (pageCount ?? Math.ceil(rowCount / pagination.pageSize))
      : undefined,
    autoResetPageIndex: !serverPaging,
  });

  const rows = table.getRowModel().rows;
  const total = serverPaging
    ? (rowCount ?? null)
    : table.getPrePaginationRowModel().rows.length;
  const pages = table.getPageCount();
  const first =
    rows.length === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const last = pagination.pageIndex * pagination.pageSize + rows.length;
  const showSkeleton = loading && data.length === 0;
  const showEmpty = !loading && rows.length === 0;
  const colSpan = table.getVisibleLeafColumns().length;

  return (
    <div className={cn("space-y-3", className)}>
      {toolbar}

      <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        <Table aria-busy={loading || undefined}>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                      className={cn(
                        "h-9 px-3 text-xs font-medium text-muted-foreground",
                        header.column.columnDef.meta?.className,
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : canSort
                          ? <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className="-ml-1 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                            >
                              {flexRender(
                                header.column.columnDef.header,
                                header.getContext(),
                              )}
                              {sorted === "asc"
                                ? <ArrowUp
                                    className="size-3"
                                    aria-hidden="true"
                                  />
                                : sorted === "desc"
                                  ? <ArrowDown
                                      className="size-3"
                                      aria-hidden="true"
                                    />
                                  : <ChevronsUpDown
                                      className="size-3 opacity-50"
                                      aria-hidden="true"
                                    />}
                            </button>
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody className={cn(loading && !showSkeleton && "opacity-60")}>
            {showSkeleton
              ? <TableRowsSkeleton rows={5} columns={colSpan} />
              : rows.map((row) => (
                  <TableRow
                    key={row.id}
                    data-state={row.getIsSelected() ? "selected" : undefined}
                    className={onRowClick ? "cursor-pointer" : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={
                      onRowClick ? () => onRowClick(row.original) : undefined
                    }
                    onKeyDown={
                      onRowClick
                        ? (event) => {
                            if (
                              event.target === event.currentTarget &&
                              event.key === "Enter"
                            ) {
                              onRowClick(row.original);
                            }
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "px-3",
                          cell.column.columnDef.meta?.className,
                        )}
                      >
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext(),
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
            {showEmpty
              ? <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={colSpan}
                    className="p-0 whitespace-normal"
                  >
                    {emptyState || (
                      <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                        Nothing to show.
                      </p>
                    )}
                  </TableCell>
                </TableRow>
              : null}
          </TableBody>
        </Table>
      </div>

      {hidePagination ||
      (pages <= 1 && (total == null || total <= PAGE_SIZES[0]))
        ? null
        : <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <p className="tabular-nums" aria-live="polite">
              {total == null
                ? `Page ${pagination.pageIndex + 1} of ${pages}`
                : `${first}-${last} of ${total}`}
            </p>
            <div className="flex items-center gap-2">
              <Select
                value={String(pagination.pageSize)}
                onValueChange={(value) => table.setPageSize(Number(value))}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Rows per page"
                  className="w-auto"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} per page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Previous page"
                onClick={() => table.previousPage()}
                disabled={!table.getCanPreviousPage()}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Next page"
                onClick={() => table.nextPage()}
                disabled={!table.getCanNextPage()}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>}
    </div>
  );
}
