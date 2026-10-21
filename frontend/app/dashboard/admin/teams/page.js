"use client";

import { Download, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Every team (moderators + admins): members with their application status,
// and the Devpost link judging uses to match each project to its team.
export default function StaffTeamsPage() {
  const user = useUser();
  const router = useRouter();
  const isStaff = user.role === "moderator" || user.role === "admin";
  const [teams, setTeams] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch("/api/admin/teams")
      .then((data) => setTeams(data.teams))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!isStaff) router.replace("/dashboard");
    else load();
  }, [isStaff, router, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (teams || []).filter(
      (t) =>
        (!missingOnly || !t.devpostUrl) &&
        (!q ||
          t.name.toLowerCase().includes(q) ||
          t.members.some((m) =>
            `${m.name} ${m.email}`.toLowerCase().includes(q),
          )),
    );
  }, [teams, query, missingOnly]);

  if (!isStaff) return null;

  function downloadCsv() {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [
        "Team",
        "Devpost URL",
        "Member",
        "Email",
        "Leader",
        "Application status",
      ],
    ];
    for (const t of visible) {
      for (const m of t.members) {
        rows.push([
          t.name,
          t.devpostUrl,
          m.name,
          m.email,
          m.leader ? "yes" : "",
          m.applicationStatus,
        ]);
      }
    }
    const blob = new Blob([rows.map((r) => r.map(cell).join(",")).join("\n")], {
      type: "text/csv",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "teams.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const withLink = (teams || []).filter((t) => t.devpostUrl).length;

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Teams
      </h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        {teams
          ? `${teams.length} teams · ${withLink} with a Devpost link`
          : "Teams and their Devpost projects."}
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <input
          className="input"
          aria-label="Search teams"
          placeholder="Search team, member or email"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 280 }}
        />
        <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          <input
            type="checkbox"
            checked={missingOnly}
            onChange={(e) => setMissingOnly(e.target.checked)}
          />
          No Devpost link yet
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", gap: "0.4rem" }}
          disabled={loading}
          onClick={load}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", gap: "0.4rem" }}
          disabled={!visible.length}
          onClick={downloadCsv}
        >
          <Download size={16} aria-hidden="true" /> Download CSV
        </button>
      </div>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      {!teams
        ? <p className="muted">Loading…</p>
        : visible.length === 0
          ? <div className="card" style={{ padding: "1.5rem" }}>
              <p className="muted">No teams match.</p>
            </div>
          : <div className="card" style={{ overflowX: "auto" }}>
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
                    <th style={{ padding: "0.75rem 1rem" }}>Team</th>
                    <th style={{ padding: "0.75rem 1rem" }}>Members</th>
                    <th style={{ padding: "0.75rem 1rem" }}>Devpost</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t) => (
                    <tr
                      key={t._id}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        verticalAlign: "top",
                      }}
                    >
                      <td style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>
                        {t.name}
                        {t.pendingInvites
                          ? <div
                              className="muted"
                              style={{ fontSize: "0.78rem", fontWeight: 400 }}
                            >
                              {t.pendingInvites} pending invite
                              {t.pendingInvites === 1 ? "" : "s"}
                            </div>
                          : null}
                      </td>
                      <td style={{ padding: "0.75rem 1rem" }}>
                        {t.members.map((m) => (
                          <div key={m._id}>
                            {m.name}
                            {m.leader ? " (leader)" : ""}{" "}
                            <span
                              className="muted"
                              style={{ fontSize: "0.8rem" }}
                            >
                              {m.email} ·{" "}
                              {m.applicationStatus === "none"
                                ? "no application"
                                : m.applicationStatus}
                            </span>
                          </div>
                        ))}
                      </td>
                      <td style={{ padding: "0.75rem 1rem" }}>
                        {t.devpostUrl
                          ? <a
                              className="link"
                              href={t.devpostUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ overflowWrap: "anywhere" }}
                            >
                              {t.devpostUrl.replace(
                                "https://devpost.com/software/",
                                "",
                              )}
                            </a>
                          : <span className="muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}
    </div>
  );
}
