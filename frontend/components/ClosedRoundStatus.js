"use client";

import { CircleCheck } from "lucide-react";

const STATUS_LINES = {
  pending: "Submitted — under review.",
  rejected: "Not accepted.",
  waitlisted:
    "You're on the waitlist. We'll email you if a spot opens up — there's nothing more you need to do.",
};

// What the home page's application card says when no application round is
// open. `latest` is the applicant's standing across all rounds (from
// GET /api/applications/me): an accepted attendee is told they're in (or
// already checked in) rather than that applications are closed, which is the
// message they'd otherwise get on event day.
export default function ClosedRoundStatus({ latest }) {
  if (!latest) {
    return (
      <p className="muted">
        Applications aren&apos;t open right now. Check back soon.
      </p>
    );
  }

  const status = latest.application.status;
  return (
    <>
      {latest.round
        ? <p style={{ marginBottom: "0.5rem" }}>
            Round: <strong>{latest.round.name}</strong>
          </p>
        : null}
      {status === "accepted"
        ? latest.checkedIn
          ? <p style={{ color: "var(--success)", fontWeight: 600 }}>
              <CircleCheck
                size={16}
                aria-hidden="true"
                style={{ verticalAlign: "-3px" }}
              />{" "}
              You&apos;re checked in. Enjoy the event!
            </p>
          : <p style={{ fontWeight: 600 }}>
              You&apos;re in! See you at check-in — have your QR code ready.
            </p>
        : <p>{STATUS_LINES[status] || status}</p>}
    </>
  );
}
