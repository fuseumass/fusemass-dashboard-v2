import { cn } from "@/lib/utils";

// Title block at the top of a dashboard page: one h1, an optional sentence of
// context, and the page's primary action on the right. Type scale: page title
// text-2xl/semibold, description text-sm/muted (see DESIGN.md).
export default function PageHeader({ title, description, actions, className }) {
  return (
    <div
      className={cn(
        "mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description
          ? <p className="text-sm text-muted-foreground">{description}</p>
          : null}
      </div>
      {actions
        ? <div className="flex items-center gap-2">{actions}</div>
        : null}
    </div>
  );
}
