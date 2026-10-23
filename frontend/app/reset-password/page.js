"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import AuthShell from "@/components/AuthShell";
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
import { apiFetch, saveToken } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";

const resetSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters long."),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetInner />
    </Suspense>
  );
}

function ResetInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") || "";
  // Set when the link is the first-password email sent on acceptance to
  // someone who applied without an account.
  const isSetup = params.get("setup") === "1";

  const form = useForm({
    resolver: zodResolver(resetSchema),
    defaultValues: { password: "", confirm: "" },
  });

  async function onSubmit(values) {
    form.clearErrors("root.server");
    try {
      const data = await apiFetch("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, password: values.password }),
      });
      saveToken(data.token);
      router.push("/dashboard");
    } catch (err) {
      applyServerError(form, err);
    }
  }

  if (!token) {
    return (
      <AuthShell
        title="Invalid link"
        footer={
          <Link
            href="/forgot-password"
            className="font-medium text-link hover:underline"
          >
            Request a new link
          </Link>
        }
      >
        <Alert variant="destructive">
          <AlertDescription>
            This reset link is missing its token or is malformed.
          </AlertDescription>
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={isSetup ? "Set up your account" : "Set a new password"}>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          noValidate
          className="space-y-4"
        >
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>New password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="confirm"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Confirm password</FormLabel>
                <FormControl>
                  <PasswordInput autoComplete="new-password" {...field} />
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
            {form.formState.isSubmitting
              ? "Saving"
              : isSetup
                ? "Set password"
                : "Reset password"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
