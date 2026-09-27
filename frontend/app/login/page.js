"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import AuthShell from "@/components/AuthShell";
import GoogleButton from "@/components/GoogleButton";
import { apiFetch, EXPIRED_MESSAGE, saveToken } from "@/lib/api";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

// Reasons we may have been sent here, rather than the visitor navigating in.
function reasonFromParams(params) {
  if (params.get("expired") === "1") {
    return EXPIRED_MESSAGE;
  }
  if (params.get("error") === "google") {
    return "Google sign-in failed. Try again.";
  }
  return "";
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(reasonFromParams(params));
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      setSubmitting(false);
      return;
    }

    if (!password) {
      setError("Password is required.");
      setSubmitting(false);
      return;
    }

    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      saveToken(data.token);
      router.push("/dashboard");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to continue your application"
    >
      <GoogleButton label="Continue with Google" withDivider />

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}
      >
        <div>
          <label className="field-label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
            }}
          >
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <Link
              href="/forgot-password"
              className="link"
              style={{ fontSize: "0.8rem" }}
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error
          ? <div className="alert-error" role="alert">
              {error}
            </div>
          : null}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p
        className="muted"
        style={{
          textAlign: "center",
          marginTop: "1.25rem",
          fontSize: "0.9rem",
        }}
      >
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="link">
          Sign up
        </Link>
      </p>
    </AuthShell>
  );
}
