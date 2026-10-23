import { Separator } from "@/components/ui/separator";

// "or" divider used between the Google button and the email form.
export default function Divider({ label = "or" }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <Separator className="flex-1" />
    </div>
  );
}
