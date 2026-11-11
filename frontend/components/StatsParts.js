import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { API_URL, getToken } from "@/lib/api";

// Pieces shared by the admin Statistics and User groups pages: number
// formatting, the headline strip, panels, ranked bar lists, and authenticated
// file downloads.

export const number = (n) => Number(n || 0).toLocaleString();

export function percent(count, total) {
  if (!total) return "0%";
  const value = (count * 100) / total;
  return value > 0 && value < 1 ? "<1%" : `${Math.round(value)}%`;
}

// Download a file from the API. A plain link can't carry the login token, so
// the file is fetched and handed to the browser as a blob.
export async function downloadFile(path, fallbackName) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let message = `Download failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // Not JSON; keep the generic message.
    }
    throw new Error(message);
  }
  const blob = await res.blob();
  const named = /filename="([^"]+)"/.exec(
    res.headers.get("Content-Disposition") || "",
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = named ? named[1] : fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

export function Panel({ title, description, children }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description
          ? <CardDescription className="text-xs">{description}</CardDescription>
          : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// One headline number in the strip. Cells share the strip's border (the
// wrapper draws the outer ring; each cell draws its own right/bottom rule).
export function Kpi({ label, value, note }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">
        {number(value)}
      </div>
      {note
        ? <div className="text-xs text-muted-foreground">{note}</div>
        : null}
    </div>
  );
}

// A ranked list of horizontal bars: label, bar, count and share. One colour,
// because the rows are one measure (people); the label carries the identity.
export function BarList({ chart, otherLabel, emptyText }) {
  if (!chart || !chart.total) {
    return (
      <p className="text-sm text-muted-foreground">
        {emptyText || "No data yet."}
      </p>
    );
  }
  const max = Math.max(1, ...chart.buckets.map((b) => b.count));
  return (
    <div className="space-y-2">
      {chart.buckets.map((bucket) => (
        <div
          key={bucket.label}
          className="grid grid-cols-[minmax(5rem,10rem)_1fr_5.5rem] items-center gap-3 text-sm"
          title={`${bucket.label}: ${number(bucket.count)} (${percent(bucket.count, chart.total)})`}
        >
          <span className="truncate">{bucket.label}</span>
          <span className="h-2 rounded-full bg-muted">
            <span
              className="block h-2 rounded-full bg-brand"
              style={{
                width: `${(bucket.count / max) * 100}%`,
                minWidth: bucket.count > 0 ? 3 : 0,
              }}
            />
          </span>
          <span className="text-right whitespace-nowrap tabular-nums">
            {number(bucket.count)}
            <span className="ml-1.5 text-xs text-muted-foreground">
              {percent(bucket.count, chart.total)}
            </span>
          </span>
        </div>
      ))}
      {chart.other && chart.other.count > 0
        ? <p className="pt-1 text-xs text-muted-foreground tabular-nums">
            + {number(chart.other.distinct)} {otherLabel || "more"} (
            {number(chart.other.count)},{" "}
            {percent(chart.other.count, chart.total)})
          </p>
        : null}
    </div>
  );
}
