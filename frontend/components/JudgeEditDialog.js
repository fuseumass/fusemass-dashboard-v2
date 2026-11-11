"use client";

// Edit one judge from the admin Judges page: name, email (typos) and the
// hardware flag. Saves through PATCH /api/admin/judges/:id.
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { applyServerError, zodResolver } from "@/lib/forms";

const schema = z.object({
  name: z.string().trim().min(1, "Enter a name."),
  email: z.email("Enter a valid email.").trim(),
  hardware: z.boolean(),
});

/**
 * @param {object} props - `{ judge, onClose, onSaved(response) }`. The dialog
 *   is open while `judge` is set.
 * @returns {JSX.Element}
 */
export default function JudgeEditDialog({ judge, onClose, onSaved }) {
  const form = useForm({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", hardware: false },
  });
  const { reset } = form;

  useEffect(() => {
    if (judge) {
      reset({
        name: judge.name || "",
        email: judge.email || "",
        hardware: Boolean(judge.hardware),
      });
    }
  }, [judge, reset]);

  async function submit(values) {
    form.clearErrors("root.server");
    const body = {};
    if (values.name !== judge.name) body.name = values.name;
    if (values.email.toLowerCase() !== judge.email) body.email = values.email;
    if (values.hardware !== Boolean(judge.hardware))
      body.hardware = values.hardware;
    if (!Object.keys(body).length) {
      onClose();
      return;
    }
    try {
      const data = await apiFetch(`/api/admin/judges/${judge._id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onSaved(data);
    } catch (err) {
      applyServerError(form, err);
    }
  }

  return (
    <Dialog
      open={Boolean(judge)}
      onOpenChange={(open) => {
        if (!open && !form.formState.isSubmitting) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit judge</DialogTitle>
          <DialogDescription>
            A new email cancels a pending invite link. Resend the invite from
            the list to send one to the new address.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit(submit)}
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input type="email" autoComplete="off" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="hardware"
              render={({ field }) => (
                <FormItem className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <FormLabel>Hardware judge</FormLabel>
                    <FormDescription>
                      Gets hardware projects when assignments are generated.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormRootError />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={form.formState.isSubmitting}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
