"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";

export default function PresentAttendance() {
  const { id } = useParams();
  const screen = useRef(null);
  const [code, setCode] = useState(null);
  const [count, setCount] = useState(0);
  const [latest, setLatest] = useState(null);
  const [room, setRoom] = useState("the organizer room");
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  useEffect(() => {
    let active = true;
    async function poll() {
      try {
        const [result, attendance, history] = await Promise.allSettled([
          apiFetch(`/api/workshops/${id}/attendance/code`),
          apiFetch(`/api/workshops/${id}/attendance`),
          apiFetch(`/api/workshops/${id}/raffle`),
        ]);
        if (active) {
          if (result.status === "fulfilled") {
            setCode({ ...result.value, receivedAt: Date.now() });
            setError("");
          } else {
            setCode(null);
            setError(result.reason.message);
          }
          if (attendance.status === "fulfilled") {
            setCount(attendance.value.counts.attended);
            setRoom(attendance.value.organizerRoom);
          }
          if (history.status === "fulfilled")
            setLatest(history.value.draws[0] || null);
        }
      } catch (err) {
        if (active) {
          setCode(null);
          setError(err.message);
        }
      }
    }
    poll();
    const polling = setInterval(poll, 2000);
    const ticking = setInterval(() => setNow(Date.now()), 250);
    return () => {
      active = false;
      clearInterval(polling);
      clearInterval(ticking);
    };
  }, [id]);
  const seconds = code
    ? Math.max(0, Math.ceil(code.secondsLeft - (now - code.receivedAt) / 1000))
    : 0;
  const fresh =
    code &&
    Date.now() < +new Date(code.openUntil) &&
    Date.now() - code.receivedAt < 5000 &&
    seconds > 0;
  return (
    <div
      ref={screen}
      className="space-y-6 bg-background p-4 text-foreground md:p-6"
    >
      <PageHeader title="Workshop attendance" />
      <div className="flex gap-3">
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await screen.current.requestFullscreen();
            } catch {
              setError(
                "Full screen is unavailable. Use your browser's full screen control.",
              );
            }
          }}
        >
          Full screen
        </Button>
        <Button asChild variant="outline">
          <Link href={`/dashboard/organize/${id}`}>Back to console</Link>
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {latest && (
        <section
          className="space-y-4 border-b pb-6"
          aria-live="polite"
          aria-labelledby="winners-title"
        >
          <h2 id="winners-title" className="text-2xl font-semibold">
            Raffle winners: {latest.prize}
          </h2>
          {latest.winners
            .filter((winner) => !winner.noShow)
            .map((winner) => (
              <p key={winner._id} className="text-2xl">
                {winner.user?.name || "Deleted user"}
              </p>
            ))}
          <p className="text-base text-muted-foreground">
            Winners have been emailed to collect from {room}.
          </p>
        </section>
      )}
      <div className="py-12 text-center">
        <p className="text-base text-muted-foreground">
          Enter the code on your workshop page
        </p>
        <p className="break-all font-mono text-7xl font-semibold tracking-widest md:text-9xl">
          {fresh ? code.code : "·····"}
        </p>
        <p className="mt-6 text-2xl tabular-nums">
          {fresh ? `New code in ${seconds}s` : "Waiting for current code"}
        </p>
        <p className="mt-6 text-base tabular-nums">
          {count} attendees checked in
        </p>
      </div>
    </div>
  );
}
