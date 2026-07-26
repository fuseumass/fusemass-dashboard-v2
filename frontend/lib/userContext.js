"use client";

import { createContext, useContext } from "react";

// Holds the logged-in user for everything under the dashboard layout, so pages
// don't each re-fetch /api/auth/me.
export const UserContext = createContext(null);

export function useUser() {
  return useContext(UserContext);
}
