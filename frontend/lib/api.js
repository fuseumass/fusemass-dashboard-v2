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

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }

  return data;
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

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    throw new Error(message);
  }

  return data;
}
