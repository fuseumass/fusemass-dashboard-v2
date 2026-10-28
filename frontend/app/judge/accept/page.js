"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
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
import { apiFetch, saveToken } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";

const acceptSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters long."),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    message: "Passwords do not match.",
    path: ["confirm"],
  });

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInner />
    </Suspense>
  );
}

function AcceptInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") || "";

  const form = useForm({
    resolver: zodResolver(acceptSchema),
    defaultValues: { password: "", confirm: "" },
  });

  async function onSubmit(values) {
    form.clearErrors("root.server");
    try {
      const data = await apiFetch("/api/auth/judge/accept", {
        method: "POST",
        body: JSON.stringify({ token, password: values.password }),
      });
      saveToken(data.token);
      router.push("/dashboard/judging");
    } catch (err) {
      applyServerError(form, err);
    }
  }

  if (!token) {
    return (
      <AuthShell title="Invalid link">
        <Alert variant="destructive">
          <AlertDescription>
            This invite link is missing its token or is malformed. Ask an
            organizer to resend your invite.
          </AlertDescription>
        </Alert>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Accept judge invite">
      <p className="mb-4 text-sm text-muted-foreground">
        Set a password to accept your judge invite. If your link has expired or
        has already been used, ask an organizer to resend your invite.
      </p>
      <GoogleButton label="Continue with Google" withDivider />
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
            {form.formState.isSubmitting ? "Saving" : "Set password"}
          </Button>
        </form>
      </Form>
    </AuthShell>
  );
}
