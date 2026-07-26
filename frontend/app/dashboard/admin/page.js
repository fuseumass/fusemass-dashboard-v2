"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const STATUSES = ["", "draft", "pending", "accepted", "rejected", "waitlisted"];

export default function AdminReviewPage() {
  const user = useUser();
  const [applications, setApplications] = useState([]);
  const [rounds, setRounds] = useState([]);
  const [status, setStatus] = useState("");
  const [round, setRound] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  // Rounds list is admin-only on the backend; moderators just skip the filter.
  useEffect(() => {
    if (user.role === "admin") {
      apiFetch("/api/admin/rounds")
        .then((data) => setRounds(data.rounds))
        .catch(() => setRounds([]));
    }
  }, [user.role]);

  const load = useCallback(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (round) qs.set("round", round);
    apiFetch(`/api/admin/applications?${qs.toString()}`)
      .then((data) => setApplications(data.applications))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [status, round]);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id, decision) {
    setError("");
    try {
      await apiFetch(`/api/admin/applications/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Applications
      </h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        Review and decide on submitted applications.
      </p>

      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          marginBottom: "1rem",
          flexWrap: "wrap",
        }}
      >
        <select
          className="select"
          style={{ maxWidth: 200 }}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {STATUSES.map((s) => (
            <option key={s || "all"} value={s}>
              {s ? s : "All statuses"}
            </option>
          ))}
        </select>
        {user.role === "admin" && rounds.length > 0
          ? <select
              className="select"
              style={{ maxWidth: 220 }}
              value={round}
              onChange={(e) => setRound(e.target.value)}
            >
              <option value="">All rounds</option>
              {rounds.map((r) => (
                <option key={r._id} value={r._id}>
                  {r.name}
                </option>
              ))}
            </select>
          : null}
      </div>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      {loading
        ? <p className="muted">Loading…</p>
        : applications.length === 0
          ? <div className="card" style={{ padding: "1.5rem" }}>
              <p className="muted">No applications match.</p>
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
                    <Th>Applicant</Th>
                    <Th>University</Th>
                    <Th>Round</Th>
                    <Th>Status</Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((app) => (
                    <tr
                      key={app._id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <Td>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setSelected(app)}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          {app.applicant ? app.applicant.name : "Unknown"}
                        </button>
                        <div className="muted" style={{ fontSize: "0.78rem" }}>
                          {app.applicant ? app.applicant.email : ""}
                        </div>
                      </Td>
                      <Td>{app.university || "—"}</Td>
                      <Td>{app.round ? app.round.name : "—"}</Td>
                      <Td>
                        <StatusBadge status={app.status} />
                      </Td>
                      <Td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <SmallBtn onClick={() => decide(app._id, "accepted")}>
                            Accept
                          </SmallBtn>
                          <SmallBtn
                            onClick={() => decide(app._id, "waitlisted")}
                          >
                            Waitlist
                          </SmallBtn>
                          <SmallBtn onClick={() => decide(app._id, "rejected")}>
                            Reject
                          </SmallBtn>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}

      {selected
        ? <ApplicationDrawer app={selected} onClose={() => setSelected(null)} />
        : null}
    </div>
  );
}

function Th({ children }) {
  return (
    <th style={{ padding: "0.75rem 1rem", fontWeight: 600 }}>{children}</th>
  );
}
function Td({ children }) {
  return (
    <td style={{ padding: "0.75rem 1rem", verticalAlign: "top" }}>
      {children}
    </td>
  );
}
function SmallBtn({ children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "0.3rem 0.6rem",
        fontSize: "0.8rem",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        cursor: "pointer",
        color: "var(--foreground)",
      }}
    >
      {children}
    </button>
  );
}
function StatusBadge({ status }) {
  const colors = {
    accepted: "var(--success)",
    rejected: "var(--danger)",
    waitlisted: "#d97706",
    pending: "var(--muted)",
    draft: "var(--muted)",
  };
  return (
    <span style={{ color: colors[status] || "var(--muted)", fontWeight: 600 }}>
      {status}
    </span>
  );
}

// Read-only detail drawer showing the full application. The backdrop is a real
// <button> (accessible) and Escape also closes it.
function ApplicationDrawer({ app, onClose }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 40,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          border: "none",
          cursor: "pointer",
        }}
      />
      <div
        className="card"
        style={{
          position: "relative",
          width: 420,
          maxWidth: "100%",
          height: "100%",
          borderRadius: 0,
          padding: "1.5rem",
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "1rem",
          }}
        >
          <h2 style={{ fontSize: "1.15rem", fontWeight: 700 }}>
            {app.name || app.applicant?.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              fontSize: "1.4rem",
              cursor: "pointer",
              color: "var(--muted)",
            }}
          >
            ×
          </button>
        </div>
        <Detail label="Email" value={app.applicant?.email} />
        <Detail label="Phone" value={app.phone} />
        <Detail label="Age" value={app.age} />
        <Detail label="Gender" value={app.gender} />
        <Detail label="Pronouns" value={app.pronouns} />
        <Detail label="Education" value={app.education} />
        <Detail label="University" value={app.university} />
        <Detail label="Major" value={app.major} />
        <Detail label="T-shirt" value={app.tshirtSize} />
        <Detail label="Allergies" value={app.allergies} />
        <Detail
          label="Programming"
          value={(app.programmingSkills || []).join(", ")}
        />
        <Detail
          label="Hardware"
          value={(app.hardwareSkills || []).join(", ")}
        />
        {app.socials
          ? <Detail
              label="Links"
              value={[
                app.socials.linkedin,
                app.socials.github,
                app.socials.website,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          : null}
        {app.resumeUrl
          ? <p style={{ marginTop: "0.75rem" }}>
              <a
                className="link"
                href={app.resumeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                View resume
              </a>
            </p>
          : null}
      </div>
    </div>
  );
}
function Detail({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div style={{ marginBottom: "0.6rem" }}>
      <div
        className="muted"
        style={{
          fontSize: "0.75rem",
          textTransform: "uppercase",
          letterSpacing: "0.03em",
        }}
      >
        {label}
      </div>
      <div>{String(value)}</div>
    </div>
  );
}
