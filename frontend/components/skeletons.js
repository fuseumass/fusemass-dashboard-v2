import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Loading placeholders shaped like the content that is coming, so the page
// does not jump when data arrives. Never a bare "Loading..." line.

/**
 * Page title + description placeholder.
 * @returns {JSX.Element}
 */
export function HeaderSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  );
}

/**
 * A card with a title and a few text lines.
 * @param {object} props - { lines: number of text lines, className }.
 * @returns {JSX.Element}
 */
export function CardSkeleton({ lines = 3, className }) {
  return (
    <Card className={className} aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-32" />
      </CardHeader>
      <CardContent className="space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton
            // Placeholders never reorder, so the index is a stable key.
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            key={i}
            className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Table rows (36px tall, like the real ones) for use inside a <TableBody>.
 * @param {object} props - { rows, columns }.
 * @returns {JSX.Element}
 */
export function TableRowsSkeleton({ rows = 5, columns = 4 }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <tr key={r} className="border-b">
          {Array.from({ length: columns }, (_, c) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder cells
            <td key={c} className="p-2">
              <Skeleton className="h-5 w-full max-w-40" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * A stack of label + input placeholders.
 * @param {object} props - { fields: how many inputs }.
 * @returns {JSX.Element}
 */
export function FormSkeleton({ fields = 4 }) {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: fields }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder fields
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Whole-page placeholder: header plus two cards. Used while the dashboard
 * loads the signed-in user and as the default `loading.js`.
 * @returns {JSX.Element}
 */
export function PageSkeleton() {
  return (
    // biome-ignore lint/a11y/useSemanticElements: <output> only allows inline content, and this wraps blocks
    <div className="space-y-6" role="status" aria-label="Loading">
      <HeaderSkeleton />
      <div className="grid gap-4 md:grid-cols-2">
        <CardSkeleton />
        <CardSkeleton lines={4} />
      </div>
    </div>
  );
}
