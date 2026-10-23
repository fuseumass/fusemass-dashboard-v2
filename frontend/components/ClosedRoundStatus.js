"use client";

import { CircleCheck } from "lucide-react";

const STATUS_LINES = {
  draft: "You started an application but have not submitted it.",
  pending:
    "Your application is in review. We will email you when there is a decision.",
  rejected: "We could not offer you a spot this time.",
  waitlisted:
    "You are on the waitlist. If a spot opens, we will email you. You do not need to do anything.",
};

// The home page's application card when there's nothing to apply to: no
// round is open, or the applicant was already accepted in an earlier round.
// `latest` is their standing across all rounds (GET /api/applications/me);
// `{ none: true }` means they never applied.
export default function ClosedRoundStatus({ latest }) {
  if (!latest || latest.none || !latest.application) {
    return (
      <p className="text-muted-foreground">
        Applications are closed.
      </p>
    );
  }

  const status = latest.application.status;
  if (status !== "accepted") {
    return (
      <p className="text-muted-foreground">{STATUS_LINES[status] || status}</p>
    );
  }
  if (latest.checkedIn) {
    return (
      <p className="flex items-center gap-1.5 font-medium text-success">
        <CircleCheck className="size-4" aria-hidden="true" />
        You're checked in.
      </p>
    );
  }
  return <p>You are accepted. Show the QR code below at check-in.</p>;
}
