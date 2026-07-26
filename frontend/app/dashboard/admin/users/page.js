"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const ROLES = ["applicant", "moderator", "admin"];

// Admin-only: search users by name/email and set their role (promote to
// moderator or admin, or demote back to applicant).
export default function UsersPage() {
  const user = useUser();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (user.role !== "admin") router.replace("/dashboard");
  }, [user.role, router]);

  // Debounced search.
  useEffect(() => {
    if (user.role !== "admin") return;
    setLoading(true);
    const handle = setTimeout(() => {
      apiFetch(`/api/admin/users?q=${encodeURIComponent(query)}`)
        .then((data) => setUsers(data.users))
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, user.role]);

  if (user.role !== "admin") return null;

  async function setRole(id, role) {
    setError("");
    try {
      const data = await apiFetch(`/api/admin/users/${id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setUsers((list) => list.map((u) => (u._id === id ? data.user : u)));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Users
      </h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        Search by name or email, then assign a role.
      </p>

      <input
        className="input"
        style={{ maxWidth: 420, marginBottom: "1rem" }}
        placeholder="Search users…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      <div className="card" style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "0.9rem",
          }}
        >
          <thead>
            <tr
              style={{
                textAlign: "left",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>Name</th>
              <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                Email
              </th>
              <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>Role</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0
              ? <tr>
                  <td colSpan={3} style={{ padding: "1rem" }} className="muted">
                    Loading…
                  </td>
                </tr>
              : users.length === 0
                ? <tr>
                    <td
                      colSpan={3}
                      style={{ padding: "1rem" }}
                      className="muted"
                    >
                      No users found.
                    </td>
                  </tr>
                : users.map((u) => (
                    <tr
                      key={u._id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <td style={{ padding: "0.75rem 1rem" }}>{u.name}</td>
                      <td style={{ padding: "0.75rem 1rem" }}>{u.email}</td>
                      <td style={{ padding: "0.75rem 1rem" }}>
                        <select
                          className="select"
                          style={{ maxWidth: 160 }}
                          value={u.role}
                          disabled={u._id === user._id}
                          onChange={(e) => setRole(u._id, e.target.value)}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        {u._id === user._id
                          ? <div
                              className="muted"
                              style={{ fontSize: "0.72rem", marginTop: 2 }}
                            >
                              (you)
                            </div>
                          : null}
                      </td>
                    </tr>
                  ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
