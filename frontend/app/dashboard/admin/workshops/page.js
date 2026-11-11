import { redirect } from "next/navigation";

// Moved to the staff section so moderators can manage it too.
export default function Moved() {
  redirect("/dashboard/staff/workshops");
}
