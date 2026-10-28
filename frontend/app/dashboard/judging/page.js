"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import JudgeCalibration from "@/components/JudgeCalibration";
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
        description="Complete calibration before scoring projects."
      />
      <JudgeCalibration />
    </div>
  );
}
