"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Logo from "@/components/Logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { config } from "@/lib/config";
import { isActive } from "@/lib/nav";

// The org mark at the top: the logo when expanded, a one-letter tile when the
// sidebar is collapsed to icons (a wide logo would not fit the rail).
export function SidebarBrand({ onNavigate }) {
  const { setOpenMobile } = useSidebar();
  function handleNavigate() {
    setOpenMobile(false);
    if (onNavigate) {
      onNavigate();
    }
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          size="lg"
          tooltip={config.orgName}
          className="data-[size=lg]:h-12"
        >
          <Link href="/dashboard" onClick={handleNavigate}>
            <span className="hidden size-8 shrink-0 items-center justify-center rounded-md bg-sidebar-accent text-sm font-semibold text-sidebar-accent-foreground group-data-[collapsible=icon]:flex">
              {config.orgName.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 group-data-[collapsible=icon]:hidden">
              <Logo variant="v2" height={32} />
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

// The grouped links, shared by the desktop sidebar, the mobile drawer and the
// kiosk menu. `groups` comes from getNavGroups() in lib/nav.js.
export function NavGroups({ groups, onNavigate }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  const allItems = groups.flatMap((group) => group.items);

  // Close the mobile drawer (or the kiosk drawer) once a link is followed.
  function handleNavigate() {
    setOpenMobile(false);
    if (onNavigate) {
      onNavigate();
    }
  }

  return (
    <>
      {groups.map((group) => (
        <SidebarGroup key={group.id}>
          {group.label
            ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            : null}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const active = isActive(item, pathname, allItems);
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      tooltip={item.label}
                    >
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        onClick={handleNavigate}
                      >
                        <item.icon aria-hidden="true" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}

// Dashboard navigation. On desktop it is a sidebar that collapses to an icon
// rail (Ctrl/Cmd+B, or the rail edge); below 768px the same content opens as a
// drawer from the top bar's menu button. Links are real <a> elements, so
// keyboard and screen-reader navigation work without extra code.
export default function AppSidebar({ groups }) {
  return (
    <Sidebar collapsible="icon" aria-label="Main">
      <SidebarHeader>
        <SidebarBrand />
      </SidebarHeader>
      <SidebarContent>
        <NavGroups groups={groups} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
