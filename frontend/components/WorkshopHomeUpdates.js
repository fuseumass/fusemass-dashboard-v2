"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api";

export default function WorkshopHomeUpdates() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const data = await apiFetch("/api/workshops");
        if (active) setItems(data.workshops);
      } catch {
        if (active) setItems([]);
      }
    }
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <div className="space-y-3">
      {items
        .filter(
          (item) => (item.attendanceOpen && !item.attended) || item.wins.length,
        )
        .map((item) => (
          <Alert key={item._id}>
            <AlertDescription>
              <Link
                className="text-link underline"
                href={`/dashboard/workshops/${item._id}`}
              >
                {item.title}
              </Link>
              {item.attendanceOpen && !item.attended && (
                <p>
                  Attendance is open. Enter the code on screen on the workshop
                  page.
                </p>
              )}
              {item.wins.map((win) => (
                <p key={win.prize}>
                  You won {win.prize}.{" "}
                  {win.claimed
                    ? "Your prize has been claimed."
                    : `Collect it from ${item.organizerRoom} after the workshop. Bring your dashboard QR code.`}
                </p>
              ))}
            </AlertDescription>
          </Alert>
        ))}
    </div>
  );
}
