"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, useState } from "react";
import CommandMenu from "@/components/CommandMenu";
import { NavGroups, SidebarBrand } from "@/components/Sidebar";
import UserMenu from "@/components/UserMenu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { getBreadcrumbs } from "@/lib/nav";

// Menu for the kiosk layout, which has no sidebar: the same links in a drawer,
// so a scanner can still get to another screen without the browser's back
// button.
function KioskMenu({ groups }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Open menu">
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-72 gap-0 bg-sidebar p-0 text-sidebar-foreground"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription>Pages you can open.</SheetDescription>
        </SheetHeader>
        <div className="p-2">
          <SidebarBrand onNavigate={close} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavGroups groups={groups} onNavigate={close} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Home > Group > Page. On a phone only the current page shows, as a title.
function Crumbs({ pathname }) {
  const crumbs = getBreadcrumbs(pathname);
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.label}-${crumb.href || index}`}>
              <BreadcrumbItem className={last ? "min-w-0" : "max-md:hidden"}>
                {last
                  ? <BreadcrumbPage className="truncate font-medium">
                      {crumb.label}
                    </BreadcrumbPage>
                  : crumb.href
                    ? <BreadcrumbLink asChild>
                        <Link href={crumb.href}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    : <span>{crumb.label}</span>}
              </BreadcrumbItem>
              {last ? null : <BreadcrumbSeparator className="max-md:hidden" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

// Top bar of the logged-in dashboard: menu toggle, where you are, quick
// navigation and the account menu. `kiosk` swaps the sidebar toggle for the
// drawer menu on the full-width scanning screens.
export default function Topbar({ user, groups, kiosk }) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-4">
      {kiosk ? <KioskMenu groups={groups} /> : <SidebarTrigger />}
      <Separator
        orientation="vertical"
        className="mx-1 data-vertical:h-4 data-vertical:self-center"
      />
      <div className="min-w-0 flex-1">
        <Crumbs pathname={pathname} />
      </div>
      <CommandMenu groups={groups} />
      <UserMenu user={user} />
    </header>
  );
}
