"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import AuthShell from "@/components/AuthShell";
import GoogleButton from "@/components/GoogleButton";
import PasswordInput from "@/components/PasswordInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { apiFetch, EXPIRED_MESSAGE, saveToken } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";

const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .refine((value) => value.includes("@"), "Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

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
    return { variant: "warning", message: EXPIRED_MESSAGE };
  }
  if (params.get("error") === "google") {
    return {
      variant: "destructive",
      message: "Google sign-in failed. Try again.",
    };
  }
  return null;
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [reason, setReason] = useState(reasonFromParams(params));

  const form = useForm({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values) {
    setReason(null);
    form.clearErrors("root.server");
    try {
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(values),
      });
      saveToken(data.token);
      router.push("/dashboard");
    } catch (err) {
      applyServerError(form, err);
    }
  }

  return (
    <AuthShell
      title="Log in"
      subtitle="Continue your application"
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="font-medium text-link hover:underline"
          >
            Sign up
          </Link>
        </>
      }
    >
      <GoogleButton label="Continue with Google" withDivider />

      {reason
        ? <Alert variant={reason.variant}>
            <AlertDescription>{reason.message}</AlertDescription>
          </Alert>
        : null}

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
          className="space-y-4"
        >
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-baseline justify-between">
                  <FormLabel>Password</FormLabel>
                  <Link
                    href="/forgot-password"
                    className="text-xs font-medium text-link hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <FormControl>
                  <PasswordInput autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormRootError />

          <Button
            type="submit"
            className="w-full"
            loading={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? "Logging in" : "Log in"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
