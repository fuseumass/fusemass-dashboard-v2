"use client";

import { Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import DataTable from "@/components/DataTable";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import SearchInput from "@/components/SearchInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const ROLES = ["applicant", "moderator", "judge", "admin"];

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

  const columns = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <div>
          <div className="font-medium text-foreground">{row.original.name}</div>
          <div className="text-xs text-muted-foreground md:hidden">
            {row.original.email}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "email",
      header: "Email",
      meta: { className: "hidden text-muted-foreground md:table-cell" },
    },
    {
      accessorKey: "role",
      header: "Role",
      cell: ({ row }) => {
        const u = row.original;
        const isSelf = u._id === user._id;
        return (
          <div className="flex items-center gap-2">
            <Select
              value={u.role}
              disabled={isSelf}
              onValueChange={(role) => setRole(u._id, role)}
            >
              <SelectTrigger
                size="sm"
                aria-label={`Role for ${u.name}`}
                className="h-7 w-32 capitalize"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r} className="capitalize">
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isSelf
              ? <span className="text-xs text-muted-foreground">You</span>
              : null}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="Users"
        description={
          loading
            ? undefined
            : query.trim()
              ? `${users.length} ${users.length === 1 ? "match" : "matches"}.`
              : users.length === 25
                ? "Showing the 25 most recent accounts. Search to find anyone."
                : `${users.length} ${users.length === 1 ? "user" : "users"}.`
        }
      />

      <DataTable
        columns={columns}
        data={users}
        loading={loading}
        dense
        getRowId={(u) => u._id}
        toolbar={
          <div className="space-y-3">
            <SearchInput
              label="Search users"
              placeholder="Search name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="sm:w-72"
            />
            {error
              ? <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              : null}
          </div>
        }
        emptyState={
          <EmptyState
            icon={Users}
            title="No users found"
            description={
              query
                ? "No one matches that search."
                : "People appear here once they create an account."
            }
          />
        }
      />
    </div>
  );
}
