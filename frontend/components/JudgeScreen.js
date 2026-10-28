"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect } from "react";
import JudgeCalibration from "@/components/JudgeCalibration";
import JudgeQueue from "@/components/JudgeQueue";
import PageHeader from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { useUser } from "@/lib/userContext";

export default function JudgeScreen({ view, title }) {
  const user = useUser();
  const router = useRouter();
  const allowed = ["judge", "admin"].includes(user.role);
  useEffect(() => {
    if (!allowed) router.replace("/dashboard");
  }, [allowed, router]);
  if (!allowed) return null;
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={
          view === "demo"
            ? "Every judge scores the same practice projects to calibrate before real judging."
            : undefined
        }
      />
      {user.role === "admin" && (
        <nav
          aria-label="Judge pages"
          className="flex flex-wrap gap-4 text-sm text-link"
        >
          {[
            ["", "Schedule"],
            ["/score", "Judging"],
            ["/skipped", "Skipped"],
            ["/demo", "Demo"],
          ].map(([path, label]) => (
            <Link key={path} href={`/dashboard/judging${path}`}>
              {label}
            </Link>
          ))}
        </nav>
      )}
      {view === "demo"
        ? <JudgeCalibration />
        : <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <JudgeQueue userId={user._id || user.id} view={view} />
          </Suspense>}
    </div>
  );
}
