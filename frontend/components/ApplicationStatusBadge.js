import { Badge } from "@/components/ui/badge";

// One place that decides how an application status looks, so the applicant's
// home and the review screens never disagree. Colour comes from the status
// tokens (success / warning / info / destructive), not from raw values.
const STATUS_VARIANTS = {
  draft: "secondary",
  pending: "info",
  accepted: "success",
  rejected: "destructive",
  waitlisted: "warning",
};

/**
 * @param {object} props - { status: draft|pending|accepted|rejected|waitlisted,
 *   label: optional text, defaults to the status itself }.
 * @returns {JSX.Element}
 */
export default function ApplicationStatusBadge({ status, label }) {
  return (
    <Badge
      variant={STATUS_VARIANTS[status] || "secondary"}
      className="capitalize"
    >
      {label || status}
    </Badge>
  );
}
