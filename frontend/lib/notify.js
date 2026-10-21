import { toast } from "sonner";
import { EXPIRED_MESSAGE } from "@/lib/api";

// Toasts for results that are not tied to a form field: a save that worked, a
// background request that failed. Field errors belong under the field (see
// components/ui/form.jsx); long-lived page errors belong in an <Alert>.
// Copy rule: sentence case, say what happened, no exclamation marks.

/**
 * Show a failed API call as a toast, with a Retry button when a retry
 * function is given. An expired session is skipped: apiFetch is already
 * sending the user to /login, and a toast would just flash on the way out.
 * @param {Error} err - Error thrown by apiFetch.
 * @param {object} [opts] - { title: what failed ("Couldn't load meals"),
 *   retry: function that repeats the request }.
 * @returns {void}
 */
export function notifyError(err, opts = {}) {
  const message = err?.message ? err.message : "Something went wrong.";
  if (message === EXPIRED_MESSAGE) {
    return;
  }
  toast.error(opts.title || message, {
    description: opts.title ? message : undefined,
    action: opts.retry ? { label: "Retry", onClick: opts.retry } : undefined,
  });
}

/**
 * @param {string} message - What succeeded ("Meal created").
 * @returns {void}
 */
export function notifySuccess(message) {
  toast.success(message);
}

/**
 * @param {string} message - Neutral information ("Copied to clipboard").
 * @returns {void}
 */
export function notifyInfo(message) {
  toast(message);
}
