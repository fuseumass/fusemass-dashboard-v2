"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { formatRange } from "@/lib/datetime";

export default function WorkshopDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const load = useCallback(async () => {
    try {
      setData(await apiFetch(`/api/workshops/${id}/me`));
    } catch (err) {
      setError(err.message);
    }
  }, [id]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);
  async function attend(value) {
    if (busy.current || value.length !== 5) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await apiFetch(`/api/workshops/${id}/attendance`, {
        method: "POST",
        body: JSON.stringify({ code: value }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      busy.current = false;
      setPending(false);
      setCode("");
    }
  }
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title={data?.workshop.title || "Workshop"} />
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
      </div>
      {!data
        ? <CardSkeleton />
        : <>
            <p className="text-sm text-muted-foreground">
              {formatRange(data.workshop.startsAt, data.workshop.endsAt)} ·{" "}
              {data.workshop.location} · {data.workshop.host}
            </p>
            <p className="text-sm">{data.workshop.description}</p>
            {data.workshop.raffleEnabled && (
              <p className="text-sm">
                Attend and enter the code to be in the raffle, drawn after the
                workshop. Signing up or viewing materials does not enter you.
              </p>
            )}
            {data.attended
              ? <Alert>
                  <AlertDescription>
                    {data.workshop.raffleEnabled
                      ? "You're checked in, and you're in the raffle"
                      : "You're checked in to this workshop"}
                  </AlertDescription>
                </Alert>
              : !data.checkedIn
                ? <p>Check in at the front desk first</p>
                : data.attendanceOpen
                  ? <form
                      className="space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        attend(code);
                      }}
                    >
                      <Label htmlFor="attendance-code">
                        Enter the code on screen
                      </Label>
                      <Input
                        id="attendance-code"
                        className="max-w-xs font-mono text-2xl tracking-widest"
                        autoComplete="off"
                        maxLength={5}
                        value={code}
                        disabled={pending}
                        onChange={(event) => {
                          const value = event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z2-9]/g, "")
                            .slice(0, 5);
                          setCode(value);
                          if (value.length === 5) attend(value);
                        }}
                      />
                      <Button
                        type="submit"
                        loading={pending}
                        disabled={code.length !== 5}
                      >
                        Record attendance
                      </Button>
                    </form>
                  : <p className="text-sm text-muted-foreground">
                      Attendance is closed. Ask the organizer when to enter the
                      code.
                    </p>}
            {data.wins.map((win, index) => (
              <Alert key={`${win.prize}-${index}`}>
                <AlertDescription>
                  You won {win.prize}.{" "}
                  {win.claimed
                    ? "Your prize has been claimed."
                    : `Collect it from ${data.organizerRoom} after the workshop. Bring your dashboard QR code.`}
                </AlertDescription>
              </Alert>
            ))}
          </>}
    </div>
  );
}
