"use client";

import { Slot } from "radix-ui";
import * as React from "react";
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
} from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// shadcn's react-hook-form bindings, in plain JavaScript. The registry no
// longer ships this file, so it lives here and is ours to edit.
//
//   <Form {...form}>
//     <form onSubmit={form.handleSubmit(onSubmit)}>
//       <FormField control={form.control} name="email" render={({ field }) => (
//         <FormItem>
//           <FormLabel>Email</FormLabel>
//           <FormControl><Input {...field} /></FormControl>
//           <FormMessage />
//         </FormItem>
//       )} />
//       <FormRootError />
//     </form>
//   </Form>

const Form = FormProvider;

const FormFieldContext = React.createContext(null);
const FormItemContext = React.createContext(null);

/**
 * Connects a named field to react-hook-form and exposes its name to the
 * FormItem / FormLabel / FormControl / FormMessage inside `render`.
 * @param {object} props - Controller props (control, name, render, ...).
 * @returns {JSX.Element}
 */
function FormField(props) {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
}

/**
 * Field state plus the generated ids that tie label, control, description and
 * message together for assistive tech.
 * @returns {object} { id, name, formItemId, formDescriptionId, formMessageId, error, ... }
 */
function useFormField() {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: fieldContext?.name });

  if (!fieldContext) {
    throw new Error("useFormField must be used inside <FormField>");
  }

  const fieldState = getFieldState(fieldContext.name, formState);
  const id = itemContext?.id;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  };
}

function FormItem({ className, ...props }) {
  const id = React.useId();

  return (
    <FormItemContext.Provider value={{ id }}>
      <div
        data-slot="form-item"
        className={cn("grid gap-1.5", className)}
        {...props}
      />
    </FormItemContext.Provider>
  );
}

function FormLabel({ className, ...props }) {
  const { error, formItemId } = useFormField();

  return (
    <Label
      data-slot="form-label"
      data-error={!!error}
      className={cn("data-[error=true]:text-destructive", className)}
      htmlFor={formItemId}
      {...props}
    />
  );
}

function FormControl({ ...props }) {
  const { error, formItemId, formDescriptionId, formMessageId } =
    useFormField();

  return (
    <Slot.Root
      data-slot="form-control"
      id={formItemId}
      aria-describedby={
        error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId
      }
      aria-invalid={!!error}
      {...props}
    />
  );
}

function FormDescription({ className, ...props }) {
  const { formDescriptionId } = useFormField();

  return (
    <p
      data-slot="form-description"
      id={formDescriptionId}
      className={cn("text-[0.8rem] text-muted-foreground", className)}
      {...props}
    />
  );
}

/**
 * The field's validation message, right under the input. Renders nothing when
 * the field is valid.
 * @param {object} props - Optional className and children (fallback text).
 * @returns {JSX.Element|null}
 */
function FormMessage({ className, children, ...props }) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error?.message ?? "") : children;

  if (!body) {
    return null;
  }

  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      role={error ? "alert" : undefined}
      className={cn("text-[0.8rem] text-destructive", className)}
      {...props}
    >
      {body}
    </p>
  );
}

/**
 * Form-level error, for failures that are not about one field (wrong
 * password, network down). Set it with `form.setError("root.server", ...)`;
 * see applyServerError in lib/forms.js.
 * @param {object} props - Optional className.
 * @returns {JSX.Element|null}
 */
function FormRootError({ className }) {
  const { formState } = useFormContext();
  const message = formState.errors.root?.server?.message;

  if (!message) {
    return null;
  }

  return (
    <Alert variant="destructive" className={className}>
      <AlertDescription>{String(message)}</AlertDescription>
    </Alert>
  );
}

export {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormRootError,
  useFormField,
};
