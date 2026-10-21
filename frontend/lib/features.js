"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

// Module on/off flags (backend B25), from the public GET /api/meta/branding.
// Every flag defaults to ON: until the answer arrives (or if the API can't be
// reached) nothing is hidden, and a missing flag never hides anything.
const ALL_ON = {
  meals: true,
  hardware: true,
  workshops: true,
  judging: true,
  raffle: true,
};

let cached = null;
const listeners = new Set();

function load(force) {
  if (!cached || force) {
    // "reload" skips the browser's 60 s HTTP cache, used after an admin saved.
    cached = apiFetch("/api/meta/branding", force ? { cache: "reload" } : {});
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

/**
 * Re-read the flags and tell every mounted `useFeatures` (e.g. the sidebar).
 * Call after saving settings so the nav updates without a page reload.
 */
export function refreshFeatures() {
  load(true)
    .then((data) => {
      for (const listener of listeners)
        listener({ ...ALL_ON, ...data.features });
    })
    .catch(() => {});
}

/**
 * The module flags, e.g. `features.meals === false` when meals is switched off.
 * Hide a nav item with `item.feature && features[item.feature] === false`.
 */
export function useFeatures() {
  const [features, setFeatures] = useState(ALL_ON);

  useEffect(() => {
    let alive = true;
    const listener = (next) => alive && setFeatures(next);
    listeners.add(listener);
    load(false)
      .then((data) => listener({ ...ALL_ON, ...data.features }))
      .catch(() => {});
    return () => {
      alive = false;
      listeners.delete(listener);
    };
  }, []);

  return features;
}
