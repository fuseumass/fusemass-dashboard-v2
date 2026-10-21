import { cn } from "@/lib/utils";

// Shown where a list or table has nothing in it yet: an icon, one sentence
// that says what is missing, and the action that fixes it ("No meals yet.
// Create the first one."). Keep it to that; no illustrations.
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 px-4 py-10 text-center",
        className,
      )}
    >
      {Icon
        ? <div className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </div>
        : null}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description
          ? <p className="max-w-sm text-sm text-muted-foreground">
              {description}
            </p>
          : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
