import { Geist, Geist_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import { config } from "@/lib/config";
import "./globals.css";

// Runs before the first paint: re-applies the brand colours saved by
// lib/branding.js on the last visit, so the page doesn't flash the default
// colour while GET /api/meta/branding loads. Only "--brand*" names with
// "#RRGGBB" values are accepted.
const BRAND_BOOT_SCRIPT = `try{var v=JSON.parse(localStorage.getItem(${JSON.stringify(config.brandStorageKey)})||"{}");for(var k in v){if(/^--brand[a-z-]*$/.test(k)&&/^#[0-9a-fA-F]{6}$/.test(v[k]))document.documentElement.style.setProperty(k,v[k]);}}catch(e){}`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: `${config.orgName} dashboard`,
  description: `Apply to ${config.orgName} and manage your spot.`,
};

export default function RootLayout({ children }) {
  return (
    // The white-label brand color is set as a CSS variable on <html> (the :root
    // element), so it cascades everywhere and overrides the globals.css default.
    // suppressHydrationWarning: next-themes adds the `dark` class before React
    // hydrates, which would otherwise log a (harmless) attribute mismatch.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      style={{ "--brand": config.brandColor }}
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: fixed inline script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: BRAND_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
