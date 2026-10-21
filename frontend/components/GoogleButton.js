"use client";

import { useEffect, useState } from "react";
import Divider from "@/components/Divider";
import { Button } from "@/components/ui/button";
import { apiFetch, googleAuthUrl } from "@/lib/api";

// Classic "Sign in with Google" button. Navigates the browser to the backend's
// OAuth entry point, which redirects back to /auth/callback with a token.
// Renders nothing (button AND the "or" divider) when Google sign-in is
// unavailable — not configured, disabled by env, or turned off by an admin.
export default function GoogleButton({
  label = "Sign in with Google",
  withDivider = false,
}) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    apiFetch("/api/meta/config")
      .then((data) => setEnabled(Boolean(data.googleAuthEnabled)))
      .catch(() => setEnabled(false));
  }, []);

  if (!enabled) {
    return null;
  }

  function handleClick() {
    window.location.href = googleAuthUrl;
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={handleClick}
      >
        <GoogleIcon />
        {label}
      </Button>
      {withDivider ? <Divider /> : null}
    </>
  );
}

// Google's mark keeps its four brand colours: that is Google's branding rule,
// not ours, so these hex values are the one allowed exception to "no raw hex".
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
