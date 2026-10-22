"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
import { API_URL } from "@/lib/api";
import { useBranding } from "@/lib/branding";
import { isActive } from "@/lib/nav";

// The org mark at the top: a tile in the brand colour with the org's initial
// (or its uploaded logo), then the name. Collapsed to the icon rail, only the
// tile shows.
export function SidebarBrand({ onNavigate }) {
  const { setOpenMobile } = useSidebar();
  const branding = useBranding();
  const name = branding.orgName || "Dashboard";
  const logo = branding.logoUrl
    ? branding.logoUrl.startsWith("/")
      ? `${API_URL}${branding.logoUrl}`
      : branding.logoUrl
    : "";
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
          tooltip={name}
          className="data-[size=lg]:h-12"
        >
          <Link href="/dashboard" onClick={handleNavigate}>
            {logo
              ? // biome-ignore lint/performance/noImgElement: admin-uploaded logo served by the API
                <img
                  src={logo}
                  alt=""
                  className="size-8 shrink-0 rounded-md object-contain"
                />
              : <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-brand text-sm font-semibold text-brand-foreground">
                  {name.charAt(0).toUpperCase()}
                </span>}
            <span className="min-w-0 truncate text-base font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
              {name}
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
                      className="data-active:bg-brand/12 data-active:text-link data-active:[&_svg]:text-link"
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
