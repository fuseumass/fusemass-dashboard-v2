"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import Logo from "@/components/Logo";
import { clearToken } from "@/lib/api";

// TreeHacks-style fixed left navigation for the logged-in dashboard.
export default function Sidebar({ user }) {
  const pathname = usePathname();
  const router = useRouter();

  const role = user ? user.role : "applicant";
  const isModerator = role === "moderator" || role === "admin";
  const isAdmin = role === "admin";

  const nav = [
    { href: "/dashboard", label: "Home", icon: "🏠" },
    { href: "/dashboard/application", label: "Application", icon: "📝" },
  ];
  if (isModerator) {
    // Moderators and admins review applications.
    nav.push({ href: "/dashboard/admin", label: "Review", icon: "🗂️" });
    // Event-day scanning: first arrival, and the meal line.
    nav.push({
      href: "/dashboard/staff/checkin",
      label: "Check-in",
      icon: "📷",
    });
    nav.push({
      href: "/dashboard/staff/meals",
      label: "Meal check-in",
      icon: "🥪",
    });
  }
  if (isAdmin) {
    // Org setup is admin-only.
    nav.push({ href: "/dashboard/admin/users", label: "Users", icon: "👥" });
    nav.push({ href: "/dashboard/admin/meals", label: "Meals", icon: "🍽️" });
    nav.push({
      href: "/dashboard/admin/schedule",
      label: "Run of show",
      icon: "🗓️",
    });
    nav.push({
      href: "/dashboard/admin/settings",
      label: "Settings",
      icon: "⚙️",
    });
  }

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <aside
      style={{
        width: 240,
        flexShrink: 0,
        borderRight: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 0,
        height: "100vh",
      }}
    >
      <div style={{ padding: "1.25rem 1.25rem 1rem" }}>
        <Logo variant="v2" height={36} />
      </div>

      <nav style={{ flex: 1, padding: "0.5rem" }}>
        {nav.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.65rem",
                padding: "0.6rem 0.75rem",
                margin: "2px 0",
                borderRadius: 10,
                fontSize: "0.92rem",
                fontWeight: 500,
                textDecoration: "none",
                color: active ? "var(--brand)" : "var(--foreground)",
                background: active
                  ? "color-mix(in srgb, var(--brand) 12%, transparent)"
                  : "transparent",
              }}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div style={{ padding: "0.75rem", borderTop: "1px solid var(--border)" }}>
        <div style={{ padding: "0.5rem 0.75rem" }}>
          <div
            style={{
              fontSize: "0.88rem",
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user ? user.name : ""}
          </div>
          <div
            className="muted"
            style={{
              fontSize: "0.78rem",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {user ? user.email : ""}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleLogout}
          style={{ marginTop: 6 }}
        >
          Log out
        </button>
      </div>
    </aside>
  );
}
