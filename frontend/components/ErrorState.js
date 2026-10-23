import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// A failed load that the user can retry. Used by the error boundaries
// (app/error.js, app/dashboard/error.js) and by pages whose request failed.
export default function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  className,
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-10 text-center",
        className,
      )}
    >
      <div className="flex size-9 items-center justify-center rounded-md bg-destructive/10 text-destructive">
        <TriangleAlert className="size-4" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {message
          ? <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
          : null}
      </div>
      {onRetry
        ? <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        : null}
    </div>
  );
}
