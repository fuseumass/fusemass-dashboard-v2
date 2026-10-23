"use client";

import { useEffect, useState } from "react";
import { config } from "@/lib/config";
import { loadSiteMeta } from "@/lib/features";

// Runtime branding (F12). The admin sets the colours, name and logos in
// Settings; the backend serves them at GET /api/meta/branding. They are
// written as CSS variables on <html>, so every bg-brand / bg-primary /
// ring-ring follows without a rebuild. The last colours seen are kept in
// localStorage and applied by an inline script in app/layout.js before the
// first paint, so a reload doesn't flash the default colour.

export const BRAND_STORAGE_KEY = config.brandStorageKey;

const HEX = /^#[0-9a-fA-F]{6}$/;

const DEFAULTS = {
  orgName: config.orgName,
  primaryColor: config.brandColor,
  secondaryColor: null,
  accentColor: null,
  logoUrl: null,
  logoDarkUrl: null,
  faviconUrl: null,
};

/**
 * Black or white, whichever reads better on a colour (WCAG relative luminance).
 * @param {string} hex - "#RRGGBB".
 * @returns {string} "#111111" or "#ffffff".
 */
export function readableOn(hex) {
  const channels = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance =
    0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  // 0.179 is where black and white text have equal contrast.
  return luminance > 0.179 ? "#111111" : "#ffffff";
}

/**
 * CSS variables for a branding object. Invalid colours are skipped, so the
 * stylesheet defaults stay in charge.
 * @param {object} branding - `{ primaryColor, secondaryColor, accentColor }`.
 * @returns {Record<string, string>}
 */
export function brandVars(branding) {
  const vars = {};
  const primary = HEX.test(branding?.primaryColor || "")
    ? branding.primaryColor
    : null;
  const secondary = HEX.test(branding?.secondaryColor || "")
    ? branding.secondaryColor
    : null;
  const accent = HEX.test(branding?.accentColor || "")
    ? branding.accentColor
    : null;
  if (primary) {
    vars["--brand"] = primary;
    vars["--brand-foreground"] = readableOn(primary);
  }
  if (secondary) {
    vars["--brand-secondary"] = secondary;
    vars["--brand-secondary-foreground"] = readableOn(secondary);
  }
  if (accent) {
    vars["--brand-accent"] = accent;
  }
  return vars;
}

/**
 * Write the branding colours onto <html> and remember them for next load.
 * @param {object} branding - From GET /api/meta/branding.
 * @returns {void}
 */
export function applyBranding(branding) {
  const vars = brandVars(branding);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  try {
    localStorage.setItem(BRAND_STORAGE_KEY, JSON.stringify(vars));
  } catch {
    // Private mode or storage blocked: the colours still apply for this visit.
  }
}

let current = null;
const listeners = new Set();

/**
 * Fetch the branding again (after an admin saved it) and apply it.
 * @returns {Promise<void>}
 */
export function refreshBranding() {
  return loadSiteMeta(true)
    .then((data) => {
      current = { ...DEFAULTS, ...data.branding };
      applyBranding(current);
      for (const listener of listeners) listener(current);
    })
    .catch(() => {});
}

/**
 * The org's branding: name, colours and logo URLs. Starts from the build-time
 * defaults and switches to the server's values once they arrive.
 * @returns {object}
 */
export function useBranding() {
  const [branding, setBranding] = useState(current || DEFAULTS);

  useEffect(() => {
    let alive = true;
    const listener = (next) => alive && setBranding(next);
    listeners.add(listener);
    loadSiteMeta(false)
      .then((data) => {
        current = { ...DEFAULTS, ...data.branding };
        applyBranding(current);
        listener(current);
      })
      .catch(() => {});
    return () => {
      alive = false;
      listeners.delete(listener);
    };
  }, []);

  return branding;
}

/**
 * Mount once (in Providers) so every page, logged in or not, gets the colours.
 * @returns {null}
 */
export function BrandingApplier() {
  useBranding();
  return null;
}
