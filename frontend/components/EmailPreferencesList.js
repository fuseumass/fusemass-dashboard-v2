"use client";

import { Lock } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * One switch per optional email category, with a line saying what it covers.
 * Security email is listed with a lock (it can't be turned off). Shared by
 * the dashboard's Account page and the public unsubscribe page.
 * @param {object} props
 * @param {Array<object>} props.categories - From the API: { key, label, description, optional }.
 * @param {object} props.preferences - { decisions, account, event, announcements }.
 * @param {function} props.onChange - (key, value) => void.
 * @param {string} [props.busyKey] - Category being saved right now.
 * @param {string} [props.highlight] - Category to mark ("this email").
 * @returns {JSX.Element}
 */
export default function EmailPreferencesList({
  categories,
  preferences,
  onChange,
  busyKey,
  highlight,
}) {
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {categories.map((category) => {
        const id = `email-pref-${category.key}`;
        const on = category.optional
          ? preferences[category.key] === true
          : true;
        return (
          <li
            key={category.key}
            className={cn(
              "flex items-start justify-between gap-4 px-3 py-3",
              highlight === category.key && "bg-muted/60",
            )}
          >
            <div className="min-w-0 space-y-0.5">
              <Label htmlFor={id} className="text-sm font-medium">
                {category.label}
                {highlight === category.key
                  ? <span className="ml-2 text-xs font-normal text-muted-foreground">
                      This email
                    </span>
                  : null}
              </Label>
              <p
                id={`${id}-hint`}
                className="text-[0.8rem] text-muted-foreground"
              >
                {category.description}
              </p>
            </div>
            {category.optional
              ? <Switch
                  id={id}
                  checked={on}
                  aria-describedby={`${id}-hint`}
                  disabled={Boolean(busyKey)}
                  onCheckedChange={(value) => onChange(category.key, value)}
                />
              : <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="size-3" aria-hidden="true" />
                  Always on
                </span>}
          </li>
        );
      })}
    </ul>
  );
}
