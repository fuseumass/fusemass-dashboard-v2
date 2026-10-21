import { Geist, Geist_Mono } from "next/font/google";
import Providers from "@/components/Providers";
import { config } from "@/lib/config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: `${config.orgName} — Apply`,
  description: `Application portal for ${config.orgName}.`,
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
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
