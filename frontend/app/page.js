// Simplistic landing page — entry point into the auth flow.
// The team will replace this with the real HackUMass marketing/home design.

import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>HackUMass Dashboard</h1>
      <p>Register or log in to apply.</p>
      <nav>
        <Link href="/signup">Sign up</Link>
        {" | "}
        <Link href="/login">Log in</Link>
      </nav>
    </main>
  );
}
