import { cn } from "@/lib/utils";

// A small coloured dot plus a word: how statuses read in tables and lists
// (Vercel-style), instead of a pastel pill. The word is always there, so the
// meaning never depends on colour alone.
const TONES = {
  neutral: "bg-muted-foreground",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
};

/**
 * @param {object} props
 * @param {"neutral"|"brand"|"success"|"warning"|"danger"|"info"} [props.tone]
 * @param {string} props.children - The status word, sentence case.
 * @param {string} [props.className]
 * @returns {JSX.Element}
 */
export default function StatusDot({ tone = "neutral", children, className }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 shrink-0 rounded-full",
          TONES[tone] || TONES.neutral,
        )}
      />
      {children}
    </span>
  );
}
