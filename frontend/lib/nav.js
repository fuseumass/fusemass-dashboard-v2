import {
  CalendarDays,
  ChartColumn,
  ClipboardList,
  FileText,
  Group,
  House,
  LifeBuoy,
  Sandwich,
  ScanLine,
  Settings,
  Users,
  UsersRound,
  UtensilsCrossed,
} from "lucide-react";

// The single source of truth for dashboard navigation. The sidebar, the
// breadcrumbs and the command palette all read this file, so adding a screen
// means adding one entry here.
//
// Item fields:
//   href     route, also the key for "which item is active"
//   label    text in the sidebar, breadcrumbs and command palette
//   icon     a lucide-react component
//   group    one of the ids in NAV_GROUPS
//   roles    roles allowed to see it; omit for everyone who is logged in
//   feature  module flag from B25 (meals, hardware, workshops, judging,
//            raffle); the item is hidden while that flag is explicitly off
//   exact    true when only the href itself counts as a match (Home), so it is
//            not "active" on every page below /dashboard
//   kiosk    true for scanning screens that use the full-width layout without
//            a sidebar, so they work on a phone held at a table
//
// Roles are for show only: the backend enforces access on every route and
// admin screens guard themselves too.

const STAFF = ["moderator", "admin"];
const ADMIN = ["admin"];

export const NAV_GROUPS = [
  { id: "me", label: null },
  { id: "organize", label: "Organize" },
  { id: "event", label: "Event day" },
  { id: "admin", label: "Admin" },
];

export const NAV_ITEMS = [
  { href: "/dashboard", label: "Home", icon: House, group: "me", exact: true },
  {
    href: "/dashboard/application",
    label: "Application",
    icon: FileText,
    group: "me",
  },
  { href: "/dashboard/team", label: "Team", icon: UsersRound, group: "me" },

  {
    href: "/dashboard/admin",
    label: "Review",
    icon: ClipboardList,
    group: "organize",
    roles: STAFF,
  },
  {
    href: "/dashboard/admin/teams",
    label: "Teams",
    icon: Group,
    group: "organize",
    roles: STAFF,
  },

  {
    href: "/dashboard/staff/checkin",
    label: "Check-in",
    icon: ScanLine,
    group: "event",
    roles: STAFF,
    kiosk: true,
  },
  {
    href: "/dashboard/staff/meals",
    label: "Meal check-in",
    icon: Sandwich,
    group: "event",
    roles: STAFF,
    feature: "meals",
    kiosk: true,
  },
  {
    href: "/dashboard/staff/attendees",
    label: "Attendee help",
    icon: LifeBuoy,
    group: "event",
    roles: STAFF,
  },

  {
    href: "/dashboard/admin/users",
    label: "Users",
    icon: Users,
    group: "admin",
    roles: ADMIN,
  },
  {
    href: "/dashboard/admin/stats",
    label: "Statistics",
    icon: ChartColumn,
    group: "admin",
    roles: ADMIN,
  },
  {
    href: "/dashboard/admin/meals",
    label: "Meals",
    icon: UtensilsCrossed,
    group: "admin",
    roles: ADMIN,
    feature: "meals",
  },
  {
    href: "/dashboard/admin/schedule",
    label: "Run of show",
    icon: CalendarDays,
    group: "admin",
    roles: ADMIN,
  },
  {
    href: "/dashboard/admin/settings",
    label: "Settings",
    icon: Settings,
    group: "admin",
    roles: ADMIN,
  },
];

/**
 * Can this user see the item? Role first, then the module flag.
 * @param {object} item - An entry of NAV_ITEMS.
 * @param {object|null} user - The logged-in user ({ role }), or null.
 * @param {object|null} features - Module flags { meals: true, ... }; null
 *   while they are not loaded (B25), which shows everything.
 * @returns {boolean}
 */
export function canSee(item, user, features) {
  const role = user?.role ? user.role : "applicant";
  if (item.roles && !item.roles.includes(role)) {
    return false;
  }
  if (item.feature && features && features[item.feature] === false) {
    return false;
  }
  return true;
}

/**
 * Items the user can see, in order.
 * @param {object|null} user - The logged-in user.
 * @param {object|null} features - Module flags, or null (show all).
 * @returns {object[]} Visible entries of NAV_ITEMS.
 */
export function getNavItems(user, features) {
  return NAV_ITEMS.filter((item) => canSee(item, user, features));
}

/**
 * Visible items bucketed by group, skipping empty groups.
 * @param {object|null} user - The logged-in user.
 * @param {object|null} features - Module flags, or null (show all).
 * @returns {Array<{id: string, label: (string|null), items: object[]}>}
 */
export function getNavGroups(user, features) {
  const items = getNavItems(user, features);
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.group === group.id),
  })).filter((group) => group.items.length > 0);
}

/**
 * The item that owns a pathname: the one with the longest href that matches
 * on a path boundary. So /dashboard/admin/users/42 belongs to Users, and
 * /dashboard/admin (Review) is not "active" on /dashboard/admin/users.
 * @param {string} pathname - The current location.pathname.
 * @param {object[]} [items] - Candidates; defaults to every nav item.
 * @returns {object|null} The matching item, or null.
 */
export function findNavItem(pathname, items = NAV_ITEMS) {
  let best = null;
  for (const item of items) {
    const matches =
      pathname === item.href ||
      (!item.exact && pathname.startsWith(`${item.href}/`));
    if (matches && (!best || item.href.length > best.href.length)) {
      best = item;
    }
  }
  return best;
}

/**
 * Is a given item the active one for this pathname?
 * @param {object} item - An entry of NAV_ITEMS.
 * @param {string} pathname - The current location.pathname.
 * @param {object[]} [items] - The items on screen, to resolve overlaps.
 * @returns {boolean}
 */
export function isActive(item, pathname, items = NAV_ITEMS) {
  const owner = findNavItem(pathname, items);
  return Boolean(owner) && owner.href === item.href;
}

/**
 * Does this pathname use the full-width kiosk layout?
 * @param {string} pathname - The current location.pathname.
 * @returns {boolean}
 */
export function isKioskPath(pathname) {
  const owner = findNavItem(pathname);
  return Boolean(owner?.kiosk);
}

/**
 * Breadcrumb trail for a pathname: Home > group > page, plus any deeper
 * segments in plain words. The last crumb has no href (it is the page).
 * @param {string} pathname - The current location.pathname.
 * @returns {Array<{label: string, href?: string}>}
 */
export function getBreadcrumbs(pathname) {
  const owner = findNavItem(pathname);
  if (!owner) {
    const tail = pathname
      .replace(/^\/dashboard\/?/, "")
      .split("/")
      .filter(Boolean);
    return [
      { label: "Home", href: "/dashboard" },
      ...tail.map((segment) => ({ label: humanize(segment) })),
    ];
  }

  const crumbs = [];
  if (owner.href !== "/dashboard") {
    crumbs.push({ label: "Home", href: "/dashboard" });
  }
  const group = NAV_GROUPS.find((g) => g.id === owner.group);
  if (group?.label) {
    crumbs.push({ label: group.label });
  }

  const rest = pathname.slice(owner.href.length).split("/").filter(Boolean);
  if (rest.length === 0) {
    crumbs.push({ label: owner.label });
  } else {
    crumbs.push({ label: owner.label, href: owner.href });
    rest.forEach((segment, index) => {
      const label = humanize(segment);
      crumbs.push(
        index === rest.length - 1
          ? { label }
          : {
              label,
              href: `${owner.href}/${rest.slice(0, index + 1).join("/")}`,
            },
      );
    });
  }
  return crumbs;
}

// "reset-password" -> "Reset password"; ids are left alone.
function humanize(segment) {
  const text = decodeURIComponent(segment).replace(/[-_]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
