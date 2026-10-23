"use client";

import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import AuthShell from "@/components/AuthShell";
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
import { apiFetch } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";

const forgotSchema = z.object({
  email: z
    .string()
    .trim()
    .refine((value) => value.includes("@"), "Enter a valid email address."),
});

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);

  const form = useForm({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: "" },
  });

  async function onSubmit(values) {
    form.clearErrors("root.server");
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: JSON.stringify(values),
      });
      setSent(true);
    } catch (err) {
      applyServerError(form, err);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we will send a link to set a new one."
      footer={
        <Link href="/login" className="font-medium text-link hover:underline">
          Back to log in
        </Link>
      }
    >
      {sent
        ? <Alert variant="success">
            <AlertDescription>
              If an account exists for that email, a reset link is on its way.
              Check your inbox.
            </AlertDescription>
          </Alert>
        : <Form {...form}>
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

              <FormRootError />

              <Button
                type="submit"
                className="w-full"
                loading={form.formState.isSubmitting}
              >
                {form.formState.isSubmitting ? "Sending" : "Send reset link"}
              </Button>
            </form>
          </Form>}
    </AuthShell>
  );
}
