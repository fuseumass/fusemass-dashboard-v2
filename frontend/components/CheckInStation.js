"use client";

import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import QRScanner from "@/components/QRScanner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Shared pieces of the event-day scanning screens (first check-in and meals):
// the camera + code box, the big result banner, and the per-device log.

const RECENT_LIMIT = 8;

// A check-in code is SHA-256 of the attendee's email: 64 hex characters.
const FULL_CODE = /^[a-f0-9]{64}$/i;

// Laptops/desktops (mouse or trackpad): keep the code box focused so a USB
// scanner "typing" a code just works. Not on phones/tablets, where focusing
// would pop up the keyboard over the camera.
function hasFinePointer() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches
  );
}

// Result kinds: a solid fill for the banner (kiosk banners are the one place
// DESIGN.md allows it), a text colour for the log, and an icon so the meaning
// never rests on colour alone.
const RESULT_STYLES = {
  success: {
    banner: "bg-success text-success-foreground",
    text: "text-success",
    icon: CircleCheck,
  },
  duplicate: {
    banner: "bg-warning text-warning-foreground",
    text: "text-warning",
    icon: CircleAlert,
  },
  error: {
    banner: "bg-destructive text-white",
    text: "text-destructive",
    icon: CircleX,
  },
};

/**
 * @param {string|Date} value - A date.
 * @returns {string} Local time like "9:41 AM", or "" when empty.
 */
export function formatTime(value) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
}

/**
 * Turn a failed check-in request into a result: a 409 is "already done"
 * (with when/by whom), anything else is an error.
 * @param {Error} err - Error thrown by apiFetch (has status + data).
 * @returns {object} A result for useStationLog().record.
 */
export function resultFromError(err) {
  if (err.status === 409) {
    const by = err.data?.checkedInBy ? ` by ${err.data.checkedInBy}` : "";
    return {
      kind: "duplicate",
      attendee: err.data?.attendee,
      message: err.message,
      warning: `First checked in at ${formatTime(err.data?.checkedInAt)}${by}.`,
    };
  }
  return { kind: "error", message: err.message };
}

/**
 * The last result plus a short log of recent results on this device.
 * @returns {{result: object|null, recent: Array<object>, record: function, clear: function}}
 */
export function useStationLog() {
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState([]);
  const count = useRef(0);

  function record(next) {
    count.current += 1;
    const entry = { ...next, id: count.current, at: new Date() };
    setResult(entry);
    setRecent((list) => [entry, ...list].slice(0, RECENT_LIMIT));
  }

  return { result, recent, record, clear: () => setResult(null) };
}

/**
 * Camera scanner ("Open camera", for phones and tablets), a code box for
 * handheld USB/Bluetooth scanners (they act as keyboards), and the outcome of
 * the last check-in.
 * @param {object} props
 * @param {string} props.title - Card heading.
 * @param {function(string): Promise<void>} props.onCode - Called with each scanned/typed code.
 * @param {object|null} props.result - Last result to show; may carry an
 *   `action: { label, onClick }` button (e.g. "Force check-in").
 * @returns {JSX.Element}
 */
export default function CheckInStation({ title, onCode, result }) {
  const [code, setCode] = useState("");
  const inputRef = useRef(null);
  const busyRef = useRef(false);

  function refocus() {
    if (hasFinePointer()) inputRef.current?.focus();
  }

  useEffect(() => {
    if (hasFinePointer()) inputRef.current?.focus();
  }, []);

  async function submit(value) {
    const trimmed = value.trim();
    if (!trimmed || busyRef.current) return;
    busyRef.current = true;
    setCode("");
    try {
      await onCode(trimmed);
    } finally {
      busyRef.current = false;
      refocus();
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    submit(code);
  }

  function handleChange(e) {
    const value = e.target.value;
    // Scanners that end with Tab (or nothing) instead of Enter: a complete
    // code submits itself.
    if (FULL_CODE.test(value.trim())) {
      submit(value);
      return;
    }
    setCode(value);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {result ? <ResultBanner result={result} /> : null}

        <QRScanner onScan={onCode} />

        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            ref={inputRef}
            aria-label="Check-in code"
            placeholder="Scan with a USB scanner or paste a code"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={code}
            onChange={handleChange}
            className="h-10 min-w-0 flex-1"
          />
          <Button type="submit" size="lg" disabled={!code.trim()}>
            Check in
          </Button>
        </form>

        {result?.kind === "success" && result.popup?.length
          ? <CheckInPopup key={result.id} rows={result.popup} />
          : null}
      </CardContent>
    </Card>
  );
}

// After a successful check-in: the attendee's name, pronouns, shirt size (or
// whatever admins chose in Settings) in large type. It never takes focus, so a
// USB scanner keeps typing into the code box: the next scan simply replaces
// it. Escape, a click, or "Done" closes it.
function CheckInPopup({ rows }) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;
  return (
    <div
      aria-live="polite"
      onPointerDown={() => setOpen(false)}
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay p-4 pt-[12vh]"
    >
      <div
        // Stop taps inside the card from reaching the scrim.
        onPointerDown={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-t-4 border-t-success bg-card p-6 text-card-foreground shadow-lg"
      >
        <p className="mb-4 flex items-center gap-2 text-sm font-medium text-success">
          <CircleCheck className="size-5" aria-hidden="true" />
          Checked in
        </p>
        <dl className="grid gap-4">
          {rows.map((row) => (
            <div key={row.key}>
              <dt className="text-xs text-muted-foreground">{row.label}</dt>
              <dd className="text-3xl leading-tight font-semibold tracking-tight wrap-anywhere">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        <Button
          type="button"
          size="lg"
          className="mt-6 w-full"
          onClick={() => setOpen(false)}
        >
          Done
        </Button>
      </div>
    </div>
  );
}

// Big, solid outcome of the last scan, readable at arm's length.
function ResultBanner({ result }) {
  const style = RESULT_STYLES[result.kind];
  const Icon = style.icon;
  return (
    <output
      aria-live="polite"
      className={cn("block space-y-1 rounded-xl p-4", style.banner)}
    >
      <p className="flex items-center gap-2 text-xl leading-tight font-semibold">
        <Icon className="size-6 shrink-0" aria-hidden="true" />
        {result.message}
      </p>
      {result.attendee
        ? <p className="text-base wrap-anywhere">
            <span className="font-semibold">{result.attendee.name}</span>
            <span className="opacity-80"> {result.attendee.email}</span>
          </p>
        : null}
      {result.warning ? <p className="text-sm">{result.warning}</p> : null}
      {result.action
        ? <Button
            type="button"
            variant="outline"
            className="mt-2 text-foreground"
            onClick={result.action.onClick}
          >
            {result.action.label}
          </Button>
        : null}
    </output>
  );
}

/**
 * Log of this device's recent check-ins.
 * @param {object} props
 * @param {Array<object>} props.recent - Entries from useStationLog().
 * @returns {JSX.Element|null}
 */
export function RecentScans({ recent }) {
  if (recent.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent on this device</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {recent.map((entry) => {
            const Icon = RESULT_STYLES[entry.kind].icon;
            return (
              <li key={entry.id} className="flex items-start gap-3 py-2">
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    RESULT_STYLES[entry.kind].text,
                  )}
                  aria-hidden="true"
                />
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums">
                  {formatTime(entry.at)}
                </span>
                <span className="min-w-0 wrap-anywhere">
                  {entry.attendee ? `${entry.attendee.name}: ` : ""}
                  {entry.message}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
