"use client";

import { CircleAlert, PackageOpen, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import CheckInStation from "@/components/CheckInStation";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import HardwareSearch, { unavailableReason } from "@/components/HardwareSearch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiDownload, apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { notifyError, notifySuccess } from "@/lib/notify";
import { cn } from "@/lib/utils";

// The staff hardware desk: pull up an attendee (scan or search), see and
// return what they hold, then find items and lend them one after another.
// Below it, every open or overdue loan for the whole event.

const ATTENDEE_SEARCH_MS = 250;

/** @returns {boolean} Whether a mouse or trackpad is the main pointer. */
function hasFinePointer() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: fine)").matches
  );
}

/**
 * @param {object} loan - Checkout row.
 * @returns {boolean} Open and past its deadline.
 */
function isOverdue(loan) {
  return !loan.returnedAt && loan.dueAt && new Date(loan.dueAt) < new Date();
}

/**
 * @param {object} props
 * @param {object} props.loan - Checkout row.
 * @returns {JSX.Element} Due time, red when overdue.
 */
function DueTime({ loan }) {
  if (!loan.dueAt) return <span>Return before leaving</span>;
  return (
    <span className={cn("tabular-nums", isOverdue(loan) && "text-destructive")}>
      {isOverdue(loan) ? "Overdue since " : "Due "}
      {formatDateTime(loan.dueAt)}
    </span>
  );
}

/**
 * Staff checkout station.
 * @param {object} props
 * @param {Array<object>} props.items - Inventory, loaded by the page.
 * @param {string|null} props.defaultDueAt - Deadline applied to blank due times.
 * @param {function(): Promise<void>} props.onInventoryChange - Reload stock.
 * @returns {JSX.Element}
 */
export default function HardwareStation({
  items,
  defaultDueAt,
  onInventoryChange,
}) {
  const [attendee, setAttendee] = useState(null);
  const [attendeeKey, setAttendeeKey] = useState(null);
  const [loans, setLoans] = useState([]);
  const [scanResult, setScanResult] = useState(null);
  const [pulling, setPulling] = useState(false);
  const [attendeeQuery, setAttendeeQuery] = useState("");
  const [attendeeResults, setAttendeeResults] = useState(null);
  const [searchingAttendees, setSearchingAttendees] = useState(false);
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [notes, setNotes] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const [returning, setReturning] = useState(null);
  const [returnBusy, setReturnBusy] = useState(false);
  const [allLoans, setAllLoans] = useState([]);
  const [loansFilter, setLoansFilter] = useState("open");
  const [loansLoading, setLoansLoading] = useState(true);
  const [loansError, setLoansError] = useState("");
  const [remindOpen, setRemindOpen] = useState(false);
  const [reminding, setReminding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef(null);
  const confirmRef = useRef(null);
  const searchSeq = useRef(0);
  // Bumped to move focus to the hardware search once it has rendered.
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (focusTick) searchRef.current?.focus();
  }, [focusTick]);

  // A picked item: focus "Check out" so Enter confirms.
  useEffect(() => {
    if (pickedId) confirmRef.current?.focus();
  }, [pickedId]);

  const picked = items.find((item) => item._id === pickedId) || null;
  const holding = {};
  for (const loan of loans) {
    if (loan.item?._id)
      holding[loan.item._id] = (holding[loan.item._id] || 0) + 1;
  }
  const pickedReason = picked
    ? unavailableReason(picked, holding[picked._id] || 0)
    : "";
  const teamChanged = loans.some((loan) => loan.teamChanged);

  const loadAllLoans = useCallback(async (filter) => {
    setLoansLoading(true);
    setLoansError("");
    try {
      const data = await apiFetch(
        `/api/staff/hardware/checkouts?${filter === "overdue" ? "overdue=1" : "open=1"}`,
      );
      setAllLoans(data.checkouts);
    } catch (err) {
      setLoansError(err.message);
    } finally {
      setLoansLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAllLoans(loansFilter);
  }, [loadAllLoans, loansFilter]);

  // Live attendee search while typing (server side: names live there).
  useEffect(() => {
    const q = attendeeQuery.trim();
    if (q.length < 2) {
      setAttendeeResults(null);
      return undefined;
    }
    const seq = searchSeq.current + 1;
    searchSeq.current = seq;
    const timer = setTimeout(async () => {
      setSearchingAttendees(true);
      try {
        const data = await apiFetch(
          `/api/staff/attendees?q=${encodeURIComponent(q)}`,
        );
        if (searchSeq.current === seq) setAttendeeResults(data.attendees);
      } catch (err) {
        if (searchSeq.current === seq) notifyError(err);
      } finally {
        if (searchSeq.current === seq) setSearchingAttendees(false);
      }
    }, ATTENDEE_SEARCH_MS);
    return () => clearTimeout(timer);
  }, [attendeeQuery]);

  /**
   * Load an attendee and their open loans in one request.
   * @param {object} key - { qrId } or { userId }.
   * @param {boolean} [quiet] - Refresh without clearing the screen.
   * @returns {Promise<object|null>} The attendee, or null on failure.
   */
  async function pull(key, quiet) {
    if (!quiet) setPulling(true);
    try {
      const data = await apiFetch(
        `/api/staff/hardware/checkouts?open=1&${new URLSearchParams(key)}`,
      );
      setAttendee(data.attendee);
      setAttendeeKey({ userId: data.attendee.id });
      setLoans(data.checkouts);
      setScanResult(null);
      return data.attendee;
    } catch (err) {
      if (quiet) notifyError(err, { title: "Couldn't refresh this attendee" });
      else setScanResult({ kind: "error", message: err.message });
      return null;
    } finally {
      if (!quiet) setPulling(false);
    }
  }

  async function pullAndFocus(key) {
    const found = await pull(key);
    if (!found) return;
    setAttendeeQuery("");
    setAttendeeResults(null);
    resetCheckout();
    if (found.checkedIn && hasFinePointer()) setFocusTick((n) => n + 1);
  }

  function resetCheckout() {
    setQuery("");
    setPickedId("");
    setDueAt("");
    setNotes("");
    setCheckoutError("");
  }

  function nextAttendee() {
    setAttendee(null);
    setAttendeeKey(null);
    setLoans([]);
    setScanResult(null);
    resetCheckout();
  }

  function pick(item) {
    setPickedId(item._id);
    setCheckoutError("");
  }

  async function refreshAfterChange() {
    await Promise.all([
      attendeeKey ? pull(attendeeKey, true) : null,
      onInventoryChange(),
      loadAllLoans(loansFilter),
    ]);
  }

  async function checkOut(e) {
    e.preventDefault();
    if (!picked || pickedReason || checkingOut) return;
    setCheckingOut(true);
    setCheckoutError("");
    try {
      await apiFetch("/api/staff/hardware/checkouts", {
        method: "POST",
        body: JSON.stringify({
          ...attendeeKey,
          itemId: picked._id,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          notes,
        }),
      });
      notifySuccess(`${picked.name} checked out to ${attendee.name}`);
      resetCheckout();
      setFocusTick((n) => n + 1);
      await refreshAfterChange();
    } catch (err) {
      setCheckoutError(err.message);
    } finally {
      setCheckingOut(false);
    }
  }

  async function confirmReturn() {
    if (!returning || returnBusy) return;
    setReturnBusy(true);
    try {
      const data = await apiFetch(
        `/api/staff/hardware/checkouts/${returning._id}/return`,
        { method: "POST" },
      );
      const name = returning.item?.name || "Item";
      notifySuccess(
        data.alreadyReturned
          ? `${name} was already returned`
          : `${name} returned`,
      );
      setReturning(null);
      await refreshAfterChange();
    } catch (err) {
      notifyError(err, { title: "Couldn't record the return" });
    } finally {
      setReturnBusy(false);
    }
  }

  async function sendReminders() {
    setReminding(true);
    try {
      const data = await apiFetch("/api/staff/hardware/reminders", {
        method: "POST",
        body: "{}",
      });
      notifySuccess(
        `${data.queued} ${data.queued === 1 ? "reminder" : "reminders"} queued`,
      );
      setRemindOpen(false);
    } catch (err) {
      notifyError(err, { title: "Couldn't queue reminders" });
    } finally {
      setReminding(false);
    }
  }

  async function exportHistory() {
    setExporting(true);
    try {
      await apiDownload(
        "/api/staff/hardware/export.csv",
        "hardware-checkouts.csv",
      );
      notifySuccess("Checkout history downloaded");
    } catch (err) {
      notifyError(err, { title: "Couldn't export history" });
    } finally {
      setExporting(false);
    }
  }

  const loanColumns = [
    {
      id: "item",
      header: "Item",
      cell: ({ row }) => (
        <div className="min-w-32">
          <div className="font-medium">
            {row.original.item?.name || "Archived item"}
          </div>
          {row.original.item?.location
            ? <div className="text-xs text-muted-foreground">
                {row.original.item.location}
              </div>
            : null}
        </div>
      ),
    },
    {
      id: "borrower",
      header: "Attendee",
      cell: ({ row }) =>
        row.original.user
          ? <div className="min-w-40">
              <button
                type="button"
                className="text-left font-medium text-link hover:underline"
                onClick={() => {
                  pullAndFocus({ userId: row.original.user._id });
                  window.scrollTo({ top: 0 });
                }}
              >
                {row.original.user.name}
              </button>
              <div className="text-xs text-muted-foreground wrap-anywhere">
                {row.original.user.email}
              </div>
            </div>
          : "Deleted user",
    },
    {
      id: "team",
      header: "Team",
      cell: ({ row }) => (
        <div className="min-w-28 space-y-1">
          <div>{row.original.team?.name || "No team"}</div>
          {row.original.teamChanged
            ? <Badge variant="warning">
                Changed team: {row.original.currentTeam?.name || "no team"}
              </Badge>
            : null}
        </div>
      ),
    },
    {
      accessorKey: "dueAt",
      header: "Due",
      cell: ({ row }) => (
        <div className="min-w-36">
          <DueTime loan={row.original} />
        </div>
      ),
    },
    {
      id: "return",
      header: <span className="sr-only">Return</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setReturning({ ...row.original })}
        >
          Return
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
        <section aria-label="Attendee" className="min-w-0 space-y-4">
          {attendee
            ? <Card>
                <CardHeader>
                  <CardTitle>Attendee</CardTitle>
                  <CardAction>
                    <Button variant="outline" size="lg" onClick={nextAttendee}>
                      <X aria-hidden="true" />
                      Next attendee
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div aria-live="polite" className="space-y-2">
                    <div>
                      <p className="text-base font-semibold wrap-anywhere">
                        {attendee.name}
                      </p>
                      <p className="text-sm text-muted-foreground wrap-anywhere">
                        {attendee.email}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      {attendee.checkedIn
                        ? <Badge variant="success">Checked in</Badge>
                        : <Badge variant="warning">Not checked in</Badge>}
                      <span className="text-muted-foreground">
                        Team: {attendee.team?.name || "no team"}
                      </span>
                      {teamChanged
                        ? <Badge variant="warning">Changed team</Badge>
                        : null}
                    </div>
                    {attendee.checkedIn
                      ? null
                      : <Alert variant="destructive">
                          <CircleAlert aria-hidden="true" />
                          <AlertTitle>Not checked in to the event</AlertTitle>
                          <AlertDescription>
                            Hardware checkout needs event check-in. Send them to
                            the check-in desk first. Returns still work.
                          </AlertDescription>
                        </Alert>}
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">
                      Holding{" "}
                      <span className="text-muted-foreground tabular-nums">
                        ({loans.length})
                      </span>
                    </h3>
                    {loans.length
                      ? <ul className="divide-y rounded-lg border">
                          {loans.map((loan) => (
                            <li
                              key={loan._id}
                              className="flex items-center gap-3 px-3 py-2"
                            >
                              <div className="min-w-0 flex-1 text-sm">
                                <p className="font-medium wrap-anywhere">
                                  {loan.item?.name || "Archived item"}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {loan.item?.location
                                    ? `${loan.item.location} · `
                                    : ""}
                                  <DueTime loan={loan} />
                                </p>
                                {loan.teamChanged
                                  ? <p className="text-xs text-warning">
                                      Lent while on{" "}
                                      {loan.team?.name || "no team"}
                                    </p>
                                  : null}
                              </div>
                              <Button
                                variant="outline"
                                size="lg"
                                onClick={() => setReturning({ ...loan })}
                              >
                                Return
                              </Button>
                            </li>
                          ))}
                        </ul>
                      : <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">
                          No hardware on loan.
                        </p>}
                  </div>
                </CardContent>
              </Card>
            : <>
                <CheckInStation
                  title="Attendee"
                  submitLabel="Find"
                  onCode={(qrId) => pullAndFocus({ qrId })}
                  result={scanResult}
                />
                <Card>
                  <CardHeader>
                    <CardTitle>Search attendees</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="station-attendee-search">
                        Name or email
                      </Label>
                      <Input
                        id="station-attendee-search"
                        type="search"
                        autoComplete="off"
                        enterKeyHint="search"
                        value={attendeeQuery}
                        onChange={(e) => setAttendeeQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setAttendeeQuery("");
                          if (
                            e.key === "Enter" &&
                            attendeeResults?.length === 1
                          )
                            pullAndFocus({ userId: attendeeResults[0].id });
                        }}
                        className="h-11 text-base"
                      />
                    </div>
                    <div aria-live="polite">
                      {searchingAttendees && !attendeeResults
                        ? <p className="text-xs text-muted-foreground">
                            Searching
                          </p>
                        : null}
                      {attendeeResults && !attendeeResults.length
                        ? <p className="text-sm text-muted-foreground">
                            No accepted attendee matches.
                          </p>
                        : null}
                    </div>
                    {attendeeResults?.length
                      ? <ul className="divide-y rounded-lg border">
                          {attendeeResults.map((person) => (
                            <li key={person.id}>
                              <button
                                type="button"
                                disabled={pulling}
                                onClick={() =>
                                  pullAndFocus({ userId: person.id })
                                }
                                className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-50"
                              >
                                <UserRound
                                  className="size-4 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1">
                                  <span className="block text-sm font-medium wrap-anywhere">
                                    {person.name}
                                  </span>
                                  <span className="block text-xs text-muted-foreground wrap-anywhere">
                                    {person.email}
                                  </span>
                                </span>
                                {person.checkedIn
                                  ? <Badge variant="success">Checked in</Badge>
                                  : <Badge variant="warning">
                                      Not checked in
                                    </Badge>}
                              </button>
                            </li>
                          ))}
                        </ul>
                      : null}
                  </CardContent>
                </Card>
              </>}
        </section>

        <section aria-label="Lend hardware" className="min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>Lend hardware</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {picked
                ? <form
                    onSubmit={checkOut}
                    className="space-y-4"
                    aria-label={`Check out ${picked.name}`}
                  >
                    <div className="flex items-start gap-3 rounded-lg border p-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-semibold wrap-anywhere">
                          {picked.name}
                        </p>
                        <p className="text-sm text-muted-foreground wrap-anywhere">
                          {[picked.category, picked.location]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <p className="mt-1 text-sm tabular-nums">
                          {picked.availableQty} of {picked.totalQty} left ·
                          limit {picked.maxPerAttendee || 1}
                          {holding[picked._id]
                            ? `, has ${holding[picked._id]}`
                            : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setPickedId("");
                          setCheckoutError("");
                          setFocusTick((n) => n + 1);
                        }}
                      >
                        Change
                      </Button>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="station-due-at">
                        Due time (optional, your local time)
                      </Label>
                      <Input
                        id="station-due-at"
                        type="datetime-local"
                        value={dueAt}
                        onChange={(e) => setDueAt(e.target.value)}
                        className="h-11 text-base"
                      />
                      <p className="text-xs text-muted-foreground">
                        {defaultDueAt
                          ? `Leave blank for the event return deadline, ${formatDateTime(defaultDueAt)}.`
                          : "Leave blank to have it back before they leave the event."}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="station-notes">Notes (optional)</Label>
                      <Textarea
                        id="station-notes"
                        rows={2}
                        placeholder="Condition or collateral"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                      />
                    </div>
                    <div aria-live="polite">
                      {checkoutError || pickedReason
                        ? <Alert variant="destructive">
                            <CircleAlert aria-hidden="true" />
                            <AlertDescription>
                              {checkoutError ||
                                (pickedReason === "Limit reached"
                                  ? "Attendee limit reached."
                                  : "Out of stock.")}
                            </AlertDescription>
                          </Alert>
                        : null}
                    </div>
                    <Button
                      ref={confirmRef}
                      type="submit"
                      size="lg"
                      className="h-12 w-full text-base"
                      loading={checkingOut}
                      disabled={Boolean(pickedReason) || !attendee?.checkedIn}
                    >
                      Check out to {attendee?.name}
                    </Button>
                  </form>
                : <HardwareSearch
                    items={items}
                    query={query}
                    onQueryChange={setQuery}
                    onPick={pick}
                    holding={holding}
                    disabled={!attendee?.checkedIn}
                    inputRef={searchRef}
                    label={
                      attendee
                        ? `Find hardware for ${attendee.name}`
                        : "Find hardware"
                    }
                  />}
            </CardContent>
          </Card>
        </section>
      </div>

      <section className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">All loans</h2>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              loading={exporting}
              onClick={exportHistory}
            >
              Export history
            </Button>
            <Button variant="outline" onClick={() => setRemindOpen(true)}>
              Send return reminders
            </Button>
          </div>
        </div>
        <fieldset className="flex gap-2">
          <legend className="sr-only">Show loans</legend>
          {[
            ["open", "Open"],
            ["overdue", "Overdue"],
          ].map(([value, text]) => (
            <Button
              key={value}
              size="sm"
              variant={loansFilter === value ? "default" : "outline"}
              aria-pressed={loansFilter === value}
              onClick={() => setLoansFilter(value)}
            >
              {text}
            </Button>
          ))}
        </fieldset>
        {loansError
          ? <Alert variant="destructive">
              <AlertDescription className="flex flex-wrap items-center gap-2">
                {loansError}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loadAllLoans(loansFilter)}
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          : <DataTable
              dense
              columns={loanColumns}
              data={allLoans}
              loading={loansLoading}
              getRowId={(row) => row._id}
              emptyState={
                <EmptyState
                  icon={PackageOpen}
                  title={
                    loansFilter === "overdue"
                      ? "Nothing is overdue."
                      : "No hardware is on loan."
                  }
                />
              }
            />}
      </section>

      <AlertDialog
        open={Boolean(returning)}
        onOpenChange={(open) => {
          if (!open && !returnBusy) setReturning(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Return {returning?.item?.name || "this item"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {returning?.user?.name || attendee?.name || "The attendee"} hands
              it back to the desk. This restores one unit to stock.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={returnBusy}
              onClick={() => setReturning(null)}
            >
              Cancel
            </Button>
            <Button loading={returnBusy} onClick={confirmReturn}>
              Record return
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={remindOpen}
        onOpenChange={(open) => {
          if (!open && !reminding) setRemindOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send return reminders</AlertDialogTitle>
            <AlertDialogDescription>
              Emails everyone still holding hardware with what they have and
              when it is due.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={reminding}
              onClick={() => setRemindOpen(false)}
            >
              Cancel
            </Button>
            <Button loading={reminding} onClick={sendReminders}>
              Send reminders
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
