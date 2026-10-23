"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * A settings card: title, optional description, content, and an optional
 * footer with a hint on the left and the save button on the right. Pass
 * `onSubmit` to render it as a form.
 * @param {object} props - title, description, hint, action (the save button),
 *   onSubmit, error, className, children.
 * @returns {JSX.Element}
 */
export function SettingsCard({
  title,
  description,
  hint,
  action,
  onSubmit,
  error,
  className,
  children,
}) {
  const body = (
    <>
      <CardHeader>
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorAlert message={error} />
        {children}
      </CardContent>
      {action || hint
        ? <CardFooter className="justify-between gap-3">
            <p className="text-sm text-muted-foreground">{hint}</p>
            {action}
          </CardFooter>
        : null}
    </>
  );

  if (onSubmit) {
    return (
      <Card className={className}>
        <form onSubmit={onSubmit} className="contents" noValidate>
          {body}
        </form>
      </Card>
    );
  }
  return <Card className={className}>{body}</Card>;
}

/**
 * @param {object} props - message: text to show; nothing renders when empty.
 * @returns {JSX.Element|null}
 */
export function ErrorAlert({ message, className }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription className="text-destructive">
        {message}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Placeholder lines while a card loads.
 * @param {object} props - rows: how many lines.
 * @returns {JSX.Element}
 */
export function CardLoading({ rows = 2 }) {
  return (
    <div className="space-y-3" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/**
 * One on/off setting: label and description on the left, switch on the right.
 * @param {object} props - id, title, description, checked, onCheckedChange, disabled.
 * @returns {JSX.Element}
 */
export function SettingRow({
  id,
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
  className,
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id} className="leading-snug">
          {title}
        </Label>
        {description
          ? <p className="text-sm text-muted-foreground">{description}</p>
          : null}
      </div>
      <Switch
        id={id}
        checked={Boolean(checked)}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="mt-0.5"
      />
    </div>
  );
}

/**
 * Label plus control with the standard gap.
 * @param {object} props - label, htmlFor, hint, className, children.
 * @returns {JSX.Element}
 */
export function Field({ label, htmlFor, hint, className, children }) {
  return (
    <div className={cn("grid gap-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
