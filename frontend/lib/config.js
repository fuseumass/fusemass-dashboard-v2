// White-label configuration, read from NEXT_PUBLIC_* env vars with sensible
// fallbacks so the platform works before a hackathon customizes it.
// NEXT_PUBLIC_* vars are inlined at build time, so these are safe on the client.

export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  orgName: process.env.NEXT_PUBLIC_ORG_NAME || "Hackathon",
  logo: process.env.NEXT_PUBLIC_LOGO || "",
  logoV2: process.env.NEXT_PUBLIC_LOGO_V2 || process.env.NEXT_PUBLIC_LOGO || "",
  brandColor: process.env.NEXT_PUBLIC_BRAND_COLOR || "#4f46e5",
  // IANA zone the event happens in (e.g. "America/New_York"); empty means
  // "show times in the viewer's own zone". See lib/datetime.js.
  // localStorage key for the last brand colours seen (lib/branding.js writes
  // it, the boot script in app/layout.js reads it before the first paint).
  brandStorageKey: "brand-colors",
  eventTimezone: process.env.NEXT_PUBLIC_EVENT_TIMEZONE || "",
};
