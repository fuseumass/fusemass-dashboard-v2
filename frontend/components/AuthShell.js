"use client";

import { API_URL } from "@/lib/api";
import { useBranding } from "@/lib/branding";

/**
 * The layout every signed-out page uses (login, signup, password reset, the
 * Google callback): the org mark and name, a plain heading, then the form.
 * `footer` is for the "No account? Sign up" line under the form.
 * @param {object} props - `{ title, subtitle?, children, footer? }`.
 * @returns {JSX.Element}
 */
export default function AuthShell({ title, subtitle, children, footer }) {
  const branding = useBranding();
  const name = branding.orgName || "Dashboard";
  const logo = branding.logoUrl
    ? branding.logoUrl.startsWith("/")
      ? `${API_URL}${branding.logoUrl}`
      : branding.logoUrl
    : "";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-8">
        <div className="flex flex-col items-center gap-3">
          {logo
            ? // biome-ignore lint/performance/noImgElement: admin-uploaded logo served by the API
              <img
                src={logo}
                alt=""
                className="size-10 rounded-lg object-contain"
              />
            : <span
                aria-hidden="true"
                className="flex size-10 items-center justify-center rounded-lg bg-brand text-lg font-semibold text-brand-foreground"
              >
                {name.charAt(0).toUpperCase()}
              </span>}
          <p className="text-sm font-medium text-muted-foreground">{name}</p>
        </div>
        <div className="space-y-6">
          <div className="space-y-1 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle
              ? <p className="text-sm text-muted-foreground">{subtitle}</p>
              : null}
          </div>
          <div className="space-y-4">{children}</div>
        </div>
        {footer
          ? <p className="text-center text-sm text-muted-foreground">
              {footer}
            </p>
          : null}
      </div>
    </main>
  );
}
