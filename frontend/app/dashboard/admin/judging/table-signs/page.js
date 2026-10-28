"use client";
import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

export default function TableSignsPage() {
  const user = useUser();
  const [signs, setSigns] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (user.role !== "admin") return;
    apiFetch("/api/admin/judging/table-signs")
      .then((data) => setSigns(data.signs))
      .catch((err) => setError(err.message));
  }, [user.role]);
  if (user.role !== "admin") return null;
  return (
    <div className="judging-table-signs space-y-6">
      <div className="print:hidden">
        <PageHeader title="Table signs" />
        <Button disabled={!signs?.length} onClick={() => window.print()}>
          Print table signs
        </Button>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!signs && !error && <Skeleton className="h-64 w-full" />}
      {signs?.length === 0 && <p>No tables configured. Create rooms first.</p>}
      {signs?.map((s) => (
        <section
          key={s.tableNumber}
          className="flex break-after-page flex-col items-center gap-4 rounded-lg border bg-card p-6 print:border-0"
        >
          <h2 className="text-4xl font-semibold tabular-nums">
            Table {s.tableNumber}
          </h2>
          <p className="text-2xl">{s.room}</p>
          {/* biome-ignore lint/performance/noImgElement: Printable QR data URL. */}
          <img
            src={s.qr}
            width={320}
            height={320}
            alt={`Check-in QR for table ${s.tableNumber}`}
          />
          <p>Scan from your dashboard to finish table check-in.</p>
        </section>
      ))}
    </div>
  );
}
