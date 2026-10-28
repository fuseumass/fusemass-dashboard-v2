"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import JudgeQueue from "@/components/JudgeQueue";
import PageHeader from "@/components/PageHeader";
import { useUser } from "@/lib/userContext";

export default function JudgingPage() {
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
        title="Judging"
        description="Judging opens when organizers start it."
      />
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Hardware judging</dt>
          <dd>{user.judgeProfile?.hardware ? "Enabled" : "Disabled"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Calibration</dt>
          <dd>
            {user.judgeProfile?.calibrationDone ? "Complete" : "Not started"}
          </dd>
        </div>
      </dl>
      <JudgeQueue userId={user._id || user.id} />
    </div>
  );
}
