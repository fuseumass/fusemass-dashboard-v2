// Small client-side helper for talking to the Express backend.
// The backend base URL comes from NEXT_PUBLIC_API_URL (see .env.local),
// defaulting to the local dev server.

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const TOKEN_KEY = "hackdash_token";

// URL the "Sign in with Google" button sends the browser to. The backend
// handles the OAuth handshake and redirects back to /auth/callback with a token.
export const googleAuthUrl = `${API_URL}/api/auth/google`;

// --- Token storage (JWT lives in localStorage) ------------------------------

export function saveToken(token) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(TOKEN_KEY, token);
  }
}

export function getToken() {
  if (typeof window !== "undefined") {
    return window.localStorage.getItem(TOKEN_KEY);
  }
  return null;
}

export function clearToken() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(TOKEN_KEY);
  }
}

// --- Expired session handling -----------------------------------------------
// A JWT can expire at any point after the dashboard has loaded, so every
// request is a place where the session can end. Rather than let each page
// render a bare "Request failed (401)", we detect it here and bounce to
// /login with a message.

export const EXPIRED_MESSAGE = "Your session has expired. Please log in again.";

// These endpoints answer 401 for bad credentials, not for an expired session —
// a 401 from /api/auth/login means "wrong password" and must stay on the page.
const AUTH_ENTRY_PATHS = [
  "/api/auth/judge/accept",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/setup-admin",
];

// Several requests are usually in flight at once, and any number of them can
// come back 401 together. Only the first one should navigate.
let redirecting = false;

function isAuthEntryPath(path) {
  const withoutQuery = String(path).split("?")[0];
  return AUTH_ENTRY_PATHS.includes(withoutQuery);
}

/**
 * Decide whether a 401 means "the session ended" and, if so, clear the token
 * and send the browser to /login. A hard navigation (rather than a router
 * push) is deliberate: it drops every page's in-memory copy of the old user.
 * @param {object} res - The fetch Response.
 * @param {string} path - Request path, used to spot auth-entry endpoints.
 * @param {boolean} sentToken - Whether we attached an Authorization header.
 * @returns {boolean} True when the session was treated as expired.
 */
function handleExpiredSession(res, path, sentToken) {
  // Without a token we never claimed a session, so a 401 is just a rejected
  // credential — leave it to the calling page.
  if (res.status !== 401 || !sentToken || isAuthEntryPath(path)) {
    return false;
  }

  clearToken();

  if (typeof window === "undefined" || redirecting) {
    return true;
  }
  // Already on the login page: nothing to navigate to, and reloading would
  // wipe an error the page is showing.
  if (window.location.pathname === "/login") {
    return true;
  }

  redirecting = true;
  window.location.replace("/login?expired=1");
  return true;
}

/**
 * Read the JSON body of a response and throw a useful Error when it failed.
 * @param {object} res - The fetch Response.
 * @param {string} path - Request path, for expired-session detection.
 * @param {boolean} sentToken - Whether we attached an Authorization header.
 * @returns {Promise<object|null>} Parsed body on success.
 */
async function readResponse(res, path, sentToken) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    if (handleExpiredSession(res, path, sentToken)) {
      throw new Error(EXPIRED_MESSAGE);
    }
    const error = new Error(data?.error || `Request failed (${res.status})`);
    // Callers that need more than the message (e.g. the check-in scanner
    // telling "already checked in" apart from a real failure) read these.
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

// --- Fetch wrapper ----------------------------------------------------------
// Attaches the JWT as `Authorization: Bearer <token>` so the backend's
// parseToken middleware can decode it onto req.user.

export async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  return readResponse(res, path, Boolean(token));
}

// --- Multipart upload -------------------------------------------------------
// Used by the application form to send profile fields + a resume file. Do NOT
// set Content-Type here; the browser sets the multipart boundary itself.

export async function apiUpload(path, formData, options = {}) {
  const headers = { ...(options.headers || {}) };

  const token = getToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    method: options.method || "POST",
    body: formData,
    headers,
  });

  return readResponse(res, path, Boolean(token));
}

// --- Signed file links ------------------------------------------------------
// Private files (resumes) live behind short-lived signed URLs that an
// authenticated endpoint returns as `{ url }`. A plain <a href> to that
// endpoint can't carry the JWT, so fetch the link, then navigate to it.
// The tab is opened before the request, while we're still inside the click,
// so popup blockers don't swallow it.

export async function openSignedLink(path) {
  const tab = window.open("", "_blank");
  if (!tab) {
    throw new Error(
      "Your browser blocked the new tab. Allow pop-ups for this site and try again.",
    );
  }
  try {
    const data = await apiFetch(path);
    tab.opener = null;
    tab.location.href = data.url;
  } catch (err) {
    tab.close();
    throw err;
  }
}

/** @param {string} path - Authenticated download route. @param {string} filename - Download name. @returns {Promise<void>} */
export async function apiDownload(path, filename) {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) await readResponse(res, path, Boolean(token));
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
