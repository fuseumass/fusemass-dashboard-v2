"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { API_URL } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { config } from "@/lib/config";

/**
 * The org mark and name, as on the auth pages and the sidebar.
 * @param {object} props - `{ name, logo }`.
 * @returns {JSX.Element}
 */
function Brand({ name, logo }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {logo
        ? // biome-ignore lint/performance/noImgElement: admin-uploaded logo served by the API
          <img
            src={logo}
            alt=""
            className="size-8 shrink-0 rounded-md object-contain"
          />
        : <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand text-sm font-semibold text-brand-foreground"
          >
            {name.charAt(0).toUpperCase()}
          </span>}
      <span className="truncate text-base font-semibold tracking-tight">
        {name}
      </span>
    </span>
  );
}

/**
 * Header bar of the signed-out home page: the org mark on the left, "Sign in"
 * (and "Create account") on the right. On phones the links move into a menu
 * that opens a side sheet, like the dashboard's mobile navigation.
 * @returns {JSX.Element}
 */
export default function PublicHeader() {
  const branding = useBranding();
  const [open, setOpen] = useState(false);
  const name = branding.orgName || "Dashboard";
  const logo = branding.logoUrl
    ? branding.logoUrl.startsWith("/")
      ? `${API_URL}${branding.logoUrl}`
      : branding.logoUrl
    : config.logo;

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center justify-between gap-3 px-4">
        <Brand name={name} logo={logo} />

        <nav aria-label="Account" className="flex shrink-0 items-center gap-2">
          <Button asChild variant="ghost" className="max-sm:hidden">
            <Link href="/signup">Create account</Link>
          </Button>
          <Button asChild className="max-sm:hidden">
            <Link href="/login">Sign in</Link>
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-lg"
                className="pointer-coarse:size-11 sm:hidden"
                aria-label="Open menu"
              >
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 gap-0">
              <SheetHeader className="pr-12">
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <SheetDescription className="sr-only">
                  Sign in or create an account.
                </SheetDescription>
                <Brand name={name} logo={logo} />
              </SheetHeader>
              <div className="flex flex-col gap-2 p-4 pt-2">
                <Button asChild size="lg" className="h-11 w-full">
                  <Link href="/login" onClick={() => setOpen(false)}>
                    Sign in
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  size="lg"
                  className="h-11 w-full"
                >
                  <Link href="/signup" onClick={() => setOpen(false)}>
                    Create account
                  </Link>
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </nav>
      </div>
    </header>
  );
}
