import { get, set } from "react-hook-form";

// Small helpers around react-hook-form + zod, so every form in the app
// validates, reports server errors and handles pending state the same way.

/**
 * react-hook-form resolver for a zod schema. We keep our own instead of
 * pulling in @hookform/resolvers, whose optional peers clash with zod 4.
 * The first issue per field wins, so a field shows one message at a time.
 * @param {object} schema - A zod schema (z.object({...})).
 * @returns {function} A resolver: (values) => Promise<{ values, errors }>.
 */
export function zodResolver(schema) {
  return async function resolver(values) {
    const result = await schema.safeParseAsync(values);
    if (result.success) {
      return { values: result.data, errors: {} };
    }
    const errors = {};
    for (const issue of result.error.issues) {
      const path = issue.path.join(".") || "root";
      if (!get(errors, path)) {
        set(errors, path, { type: issue.code, message: issue.message });
      }
    }
    return { values: {}, errors };
  };
}

/**
 * Put a failed API call back onto the form. If the backend names the field
 * (`{ error, field }` or `{ errors: { field: "message" } }`) the message shows
 * under that input; otherwise it shows in the form-level alert.
 * @param {object} form - The react-hook-form instance from useForm.
 * @param {Error} err - Error thrown by apiFetch (has .message and .data).
 * @returns {void}
 */
export function applyServerError(form, err) {
  const data = err?.data ? err.data : {};
  const fieldErrors =
    data.errors && typeof data.errors === "object" ? data.errors : null;

  if (fieldErrors) {
    for (const name of Object.keys(fieldErrors)) {
      form.setError(name, {
        type: "server",
        message: String(fieldErrors[name]),
      });
    }
    return;
  }
  if (data.field && Object.hasOwn(form.getValues(), data.field)) {
    form.setError(data.field, { type: "server", message: err.message });
    return;
  }
  form.setError("root.server", {
    type: "server",
    message: err?.message ? err.message : "Something went wrong.",
  });
}
