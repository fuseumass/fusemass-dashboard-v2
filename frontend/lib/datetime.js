import { config } from "@/lib/config";

// All date and time display goes through here, so an organizer in another
// time zone still sees the times an attendee on site sees (the "event time
// zone"), and every screen formats them the same way.
//
// The zone is an IANA name such as "America/New_York". It comes from
// NEXT_PUBLIC_EVENT_TIMEZONE for now; once GET /api/meta/branding (B28)
// serves EVENT_TIMEZONE, call setEventTimeZone() with it at startup. With no
// zone set, times show in the viewer's own zone, which is what the screens did
// before this module existed.

let eventTimeZone = "";

/**
 * @param {string} zone - An IANA time zone name, or "" to use the viewer's.
 * @returns {boolean} Whether the zone is usable (invalid names are ignored).
 */
export function setEventTimeZone(zone) {
  if (!zone) {
    eventTimeZone = "";
    return true;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    eventTimeZone = zone;
    return true;
  } catch {
    return false;
  }
}

setEventTimeZone(config.eventTimezone);

/**
 * @returns {string} The event's IANA zone, or "" when none is configured.
 */
export function getEventTimeZone() {
  return eventTimeZone;
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// True when the viewer's own zone differs from the event's, which is the case
// where a zone label stops being noise and starts being necessary.
function zoneDiffers() {
  if (!eventTimeZone) {
    return false;
  }
  const own = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return own !== eventTimeZone;
}

function format(value, options, showZone) {
  const date = toDate(value);
  if (!date) {
    return "";
  }
  const withZone =
    showZone === "always" || (showZone !== "never" && zoneDiffers());
  return new Intl.DateTimeFormat(undefined, {
    ...options,
    ...(eventTimeZone ? { timeZone: eventTimeZone } : {}),
    ...(withZone ? { timeZoneName: "short" } : {}),
  }).format(date);
}

/**
 * "Nov 14, 2026, 9:00 AM" in the event zone.
 * @param {Date|string|number} value - Anything `new Date()` accepts.
 * @param {object} [opts] - { zone: "auto" | "always" | "never" } - whether to
 *   append the zone name; "auto" does so only when the viewer is elsewhere.
 * @returns {string} Empty for invalid input.
 */
export function formatDateTime(value, opts = {}) {
  return format(value, { dateStyle: "medium", timeStyle: "short" }, opts.zone);
}

/**
 * "Sat, Nov 14" in the event zone.
 * @param {Date|string|number} value - Anything `new Date()` accepts.
 * @returns {string} Empty for invalid input.
 */
export function formatDate(value) {
  return format(
    value,
    { weekday: "short", month: "short", day: "numeric" },
    "never",
  );
}

/**
 * "9:00 AM" in the event zone.
 * @param {Date|string|number} value - Anything `new Date()` accepts.
 * @param {object} [opts] - { zone: "auto" | "always" | "never" }.
 * @returns {string} Empty for invalid input.
 */
export function formatTime(value, opts = {}) {
  return format(value, { hour: "numeric", minute: "2-digit" }, opts.zone);
}

/**
 * "Sat 9:00 AM - 10:30 AM", collapsing to one date when both ends share it.
 * @param {Date|string|number} start - Start of the range.
 * @param {Date|string|number} end - End of the range.
 * @returns {string} Empty when the start is invalid.
 */
export function formatRange(start, end) {
  const from = toDate(start);
  const to = toDate(end);
  if (!from) {
    return "";
  }
  if (!to) {
    return formatDateTime(from);
  }
  const sameDay = formatDate(from) === formatDate(to);
  return sameDay
    ? `${formatDate(from)}, ${formatTime(from, { zone: "never" })} - ${formatTime(to)}`
    : `${formatDateTime(from, { zone: "never" })} - ${formatDateTime(to)}`;
}
