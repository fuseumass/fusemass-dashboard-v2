"use client";

import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BrandingApplier } from "@/lib/branding";

// App-wide client providers, mounted once in app/layout.js:
//   - theme: a `.dark` class on <html>, following the OS until the user picks
//   - tooltips: shared open/close delay
//   - toasts: the single place sonner renders (see lib/notify.js)
//   - branding: the admin-set colours from the API (see lib/branding.js)
export default function Providers({ children }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <BrandingApplier />
      <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
      <Toaster position="top-center" />
    </ThemeProvider>
  );
}
