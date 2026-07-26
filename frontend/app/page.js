import { redirect } from "next/navigation";

// The root URL sends visitors straight to the login page (which offers signup
// at the bottom), as requested for apply.<hackathon>.com.
export default function Home() {
  redirect("/login");
}
