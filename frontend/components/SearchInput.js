import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A compact search box for table toolbars: magnifier icon, 32 px tall.
 * @param {object} props - Input props; `label` is the accessible name and
 *   `className` styles the wrapper (set its width there).
 * @returns {JSX.Element}
 */
export default function SearchInput({ label, className, ...props }) {
  return (
    <div className={cn("relative w-full sm:w-60", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input type="search" aria-label={label} className="h-8 pl-8" {...props} />
    </div>
  );
}
