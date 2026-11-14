import StatusDot from "@/components/StatusDot";

// One place that decides how an application status looks, so the applicant's
// home and the review screens never disagree: a coloured dot and a word.
const STATUS_TONES = {
  draft: "neutral",
  pending: "info",
  accepted: "success",
  rejected: "danger",
  waitlisted: "warning",
  removed: "neutral",
};

const STATUS_WORDS = {
  draft: "Draft",
  pending: "Pending",
  accepted: "Accepted",
  rejected: "Rejected",
  waitlisted: "Waitlisted",
  removed: "Withdrawn",
};

/**
 * @param {object} props - { status: draft|pending|accepted|rejected|waitlisted|removed,
 *   label: optional text, defaults to the status word }.
 * @returns {JSX.Element}
 */
export default function ApplicationStatusBadge({ status, label }) {
  return (
    <StatusDot tone={STATUS_TONES[status] || "neutral"}>
      {label || STATUS_WORDS[status] || status}
    </StatusDot>
  );
}
