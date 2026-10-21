import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, resolving Tailwind conflicts so the last one wins.
 * @param {...*} inputs - Strings, arrays or objects accepted by clsx.
 * @returns {string} The merged class string.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
