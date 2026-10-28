"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import QRScanner from "@/components/QRScanner";
import { CardSkeleton } from "@/components/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiDownload, apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";

export default function WorkshopConsole() {
  const { id } = useParams();
  const base = `/api/workshops/${id}`;
  const [data, setData] = useState(null);
  const [draws, setDraws] = useState([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [minutes, setMinutes] = useState("10");
  const [userId, setUserId] = useState("");
  const [prize, setPrize] = useState("");
  const [count, setCount] = useState("1");
  const [early, setEarly] = useState(false);
  const [now, setNow] = useState(0);
  const load = useCallback(async () => {
    try {
      const [attendance, history] = await Promise.all([
        apiFetch(`${base}/attendance`),
        apiFetch(`${base}/raffle`),
      ]);
      setData(attendance);
      setDraws(history.draws);
    } catch (err) {
      setError(err.message);
    }
  }, [base]);
  useEffect(() => {
    load();
    setNow(Date.now());
    const timer = setInterval(() => {
      load();
      setNow(Date.now());
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  async function action(path, body, success) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await apiFetch(`${base}/${path}`, {
        method: "POST",
        body: JSON.stringify(body || {}),
      });
      setMessage(success);
      await load();
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader title={data?.workshop.title || "Workshop console"} />
      <div aria-live="polite">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              {error}{" "}
              <Button variant="outline" onClick={load}>
                Refresh
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {message && (
          <Alert>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}
      </div>
      {!data
        ? <CardSkeleton />
        : <>
            <section className="space-y-4" aria-labelledby="attendance-title">
              <h2 id="attendance-title" className="text-base font-semibold">
                Attendance
              </h2>
              <p className="text-sm tabular-nums">
                {data.counts.signedUp} signed up · {data.counts.attended}{" "}
                attended · {data.counts.walkIns} walk-ins
              </p>
              <p className="text-sm text-muted-foreground">
                {+new Date(data.workshop.attendanceOpenUntil) > now
                  ? `Open until ${formatDateTime(data.workshop.attendanceOpenUntil)}`
                  : "Attendance is closed"}
              </p>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-2">
                  <Label htmlFor="minutes">Minutes</Label>
                  <Input
                    id="minutes"
                    type="number"
                    min={1}
                    max={180}
                    className="w-24"
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </div>
                {["open", "extend", "close"].map((verb) => (
                  <Button
                    key={verb}
                    variant="outline"
                    loading={pending}
                    onClick={() =>
                      action(
                        `attendance/${verb}`,
                        { minutes: Number(minutes) },
                        "Attendance session updated",
                      )
                    }
                  >
                    {verb.charAt(0).toUpperCase() + verb.slice(1)} attendance
                  </Button>
                ))}
                <Button asChild variant="outline">
                  <Link href={`/dashboard/organize/${id}/present`}>
                    Present
                  </Link>
                </Button>
                <Button
                  variant="outline"
                  loading={pending}
                  onClick={async () => {
                    setPending(true);
                    try {
                      await apiDownload(
                        `${base}/attendance.csv`,
                        "workshop-attendance.csv",
                      );
                      setMessage("Attendance CSV downloaded");
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  Download attendance CSV
                </Button>
              </div>
              <DataTable
                data={data.attendees}
                columns={[
                  {
                    id: "name",
                    header: "Attendee",
                    cell: ({ row }) =>
                      row.original.user?.name || "Deleted user",
                  },
                  {
                    id: "email",
                    header: "Email",
                    cell: ({ row }) => row.original.user?.email,
                  },
                  { accessorKey: "method", header: "Method" },
                  {
                    accessorKey: "checkedInAt",
                    header: "Time",
                    cell: ({ row }) => formatDateTime(row.original.checkedInAt),
                  },
                ]}
                emptyState={
                  <EmptyState
                    title="No attendance yet"
                    description="Open attendance to show the code."
                  />
                }
              />
              <h3 className="text-base font-semibold">Add attendee</h3>
              <QRScanner
                onScan={(qrId) =>
                  action("attendance/staff", { qrId }, "Attendee added")
                }
              />
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  action("attendance/staff", { userId }, "Attendee added");
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="attendee-id">Attendee user ID</Label>
                  <Input
                    id="attendee-id"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    required
                  />
                </div>
                <Button type="submit" variant="outline" loading={pending}>
                  Add attendee
                </Button>
              </form>
            </section>
            <section className="space-y-4" aria-labelledby="raffle-title">
              <h2 id="raffle-title" className="text-base font-semibold">
                Raffle
              </h2>
              {!data.workshop.raffleEnabled
                ? <p className="text-sm text-muted-foreground">
                    Raffle is disabled for this workshop.
                  </p>
                : <>
                    <p className="text-sm text-muted-foreground">
                      Draw unlocks at {formatDateTime(data.workshop.endsAt)}.
                      Only accepted, event checked-in attendees who have not won
                      here are eligible.
                    </p>
                    <form
                      className="flex flex-wrap items-end gap-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        action(
                          "raffle/draw",
                          { prize, count: Number(count), early },
                          `Winners have been emailed to collect from ${data.organizerRoom}`,
                        );
                      }}
                    >
                      <div className="space-y-2">
                        <Label htmlFor="prize">Prize</Label>
                        <Input
                          id="prize"
                          value={prize}
                          maxLength={200}
                          required
                          onChange={(e) => setPrize(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="count">Winners</Label>
                        <Input
                          id="count"
                          className="w-24"
                          type="number"
                          min={1}
                          required
                          value={count}
                          onChange={(e) => setCount(e.target.value)}
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="early"
                          checked={early}
                          onCheckedChange={(value) => setEarly(value === true)}
                        />
                        <Label htmlFor="early">End early</Label>
                      </div>
                      <Button
                        type="submit"
                        loading={pending}
                        disabled={
                          !prize.trim() ||
                          (!early && now < +new Date(data.workshop.endsAt))
                        }
                      >
                        Draw winners
                      </Button>
                    </form>
                  </>}
              <h3 className="text-base font-semibold">Draw history</h3>
              {!draws.length && (
                <EmptyState
                  title="No draws yet"
                  description="Record attendance before drawing winners."
                />
              )}
              {draws.map((draw) => (
                <div key={draw._id} className="space-y-3 border-t pt-4">
                  <p className="text-sm font-medium">
                    {draw.prize} · {formatDateTime(draw.createdAt)} ·{" "}
                    {draw.count} of {draw.poolSize} eligible
                    {draw.redrawOf ? " · Replacement draw" : ""}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Drawn by {draw.drawnBy?.name || "Deleted user"}
                  </p>
                  <DataTable
                    data={draw.winners}
                    columns={[
                      {
                        id: "name",
                        header: "Winner",
                        cell: ({ row }) =>
                          row.original.user?.name || "Deleted user",
                      },
                      {
                        id: "email",
                        header: "Email",
                        cell: ({ row }) => row.original.user?.email,
                      },
                      {
                        id: "state",
                        header: "Status",
                        cell: ({ row }) =>
                          row.original.noShow
                            ? "No-show"
                            : row.original.claimed
                              ? "Claimed"
                              : "Awaiting collection",
                      },
                      {
                        id: "actions",
                        header: "Actions",
                        cell: ({ row }) => (
                          <div className="flex gap-2">
                            {["claim", "redraw"].map((verb) => (
                              <Button
                                key={verb}
                                variant="outline"
                                size="sm"
                                loading={pending}
                                disabled={
                                  !row.original.user ||
                                  row.original.claimed ||
                                  row.original.noShow
                                }
                                onClick={() =>
                                  action(
                                    `raffle/${draw._id}/winners/${row.original.user._id}/${verb}`,
                                    {},
                                    verb === "claim"
                                      ? "Prize claimed"
                                      : `Replacement winner emailed to collect from ${data.organizerRoom}`,
                                  )
                                }
                              >
                                {verb === "claim" ? "Claim" : "Redraw"}
                              </Button>
                            ))}
                          </div>
                        ),
                      },
                    ]}
                  />
                </div>
              ))}
            </section>
          </>}
    </div>
  );
}
