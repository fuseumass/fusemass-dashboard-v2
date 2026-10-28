"use client";
import JudgingReports from "@/components/JudgingReports";
import PageHeader from "@/components/PageHeader";
import { useUser } from "@/lib/userContext";

/** @param {object} props - Page props. @returns {React.ReactNode} Staff progress screen. */
export default function JudgingProgressPage() {
  const user = useUser();
  if (!["moderator", "admin"].includes(user.role)) return null;
  return (
    <div className="space-y-6">
      <PageHeader title="Judging progress" />
      <JudgingReports />
    </div>
  );
}
