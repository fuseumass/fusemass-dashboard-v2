"use client";

import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/skeletons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

export default function JudgingSheetPage() {
  const user = useUser();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (user.role === "judge") return;
    let mounted = true;
    async function refresh() {
      try {
        const next = await apiFetch(`/api/judging/sheet?refresh=${retry}`);
        if (mounted) {
          setData(next);
          setError("");
        }
      } catch (err) {
        if (mounted) {
          setError(err.message);
          setData(null);
        }
      }
    }
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [user.role, retry]);
  if (user.role === "judge")
    return <p>Use your judging screen to view assignments.</p>;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Judging sheet"
        description="Current judge locations. Refreshes every 30 seconds."
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            {error}{" "}
            <Button variant="outline" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!data && !error && <CardSkeleton lines={4} />}
      {data && !data.open && (
        <p className="text-sm text-muted-foreground">Judging is closed.</p>
      )}
      {data?.open && (
        <>
          {data.ownTeam
            ? <Alert>
                <AlertDescription>
                  Your team:{" "}
                  {data.ownTeam.table
                    ? `Table ${data.ownTeam.table}, ${data.ownTeam.room}`
                    : "No table assigned"}
                  . {data.ownTeam.done} of {data.ownTeam.assigned} judgings
                  done.
                </AlertDescription>
              </Alert>
            : <p className="text-sm text-muted-foreground">
                Your team has no judging project.
              </p>}
          {[
            ["software", "Software"],
            ["hardware", "Hardware"],
          ].map(([key, title]) => (
            <section key={key} className="space-y-3">
              <h2 className="text-base font-semibold">{title}</h2>
              {!data[key].length && (
                <p className="text-sm text-muted-foreground">
                  No rooms configured.
                </p>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                {data[key].map((room) => (
                  <Card key={room.name}>
                    <CardHeader>
                      <CardTitle>{room.name}</CardTitle>
                      <p className="text-sm text-muted-foreground">
                        {room.judgeCount} judges here now
                      </p>
                    </CardHeader>
                    <CardContent>
                      {room.judges.length
                        ? <ul className="divide-y">
                            {room.judges.map((judge) => (
                              <li
                                key={judge.label}
                                className="flex justify-between py-2 text-sm"
                              >
                                <span>{judge.label}</span>
                                <span className="tabular-nums">
                                  Table {judge.table}
                                </span>
                              </li>
                            ))}
                          </ul>
                        : <p className="text-sm text-muted-foreground">
                            No judges here now.
                          </p>}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
