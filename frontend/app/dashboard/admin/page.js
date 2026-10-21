"use client";

import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { plainText } from "@/components/RichText";
import SignedLinkButton from "@/components/SignedLinkButton";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const STATUSES = ["", "draft", "pending", "accepted", "rejected", "waitlisted"];
const STALE_MS = 5 * 60 * 1000;

// Kept at module scope, so it survives navigating away and back: returning to
// Review shows the last list straight away instead of downloading it again.
// The server is only asked again by Refresh; decisions update rows in place.
// Tied to the logged-in user, so someone else signing in on the same tab
// never sees the previous reviewer's cached applications.
const reviewCache = {
  userId: null,
  list: null,
  fetchedAt: null,
  details: new Map(),
};

function cacheFor(userId) {
  if (reviewCache.userId !== userId) {
    reviewCache.userId = userId;
    reviewCache.list = null;
    reviewCache.fetchedAt = null;
    reviewCache.details = new Map();
  }
  return reviewCache;
}

export default function AdminReviewPage() {
  const user = useUser();
  const cache = cacheFor(user._id);
  const [applications, setApplications] = useState(() => cache.list || []);
  const [fetchedAt, setFetchedAt] = useState(cache.fetchedAt);
  const [loading, setLoading] = useState(!cache.list);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState("");
  const [round, setRound] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [deciding, setDeciding] = useState(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/applications");
      cache.list = data.applications;
      cache.fetchedAt = new Date();
      cache.details = new Map();
      setApplications(cache.list);
      setFetchedAt(cache.fetchedAt);
    } catch (err) {
      setError(err.message);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [cache]);

  // Fetch when there's nothing cached, or quietly in the background (the
  // cached list stays on screen) when it's over STALE_MS old, so decisions
  // other reviewers made in the meantime show up without a manual Refresh.
  useEffect(() => {
    if (!cache.list || Date.now() - cache.fetchedAt.getTime() > STALE_MS) {
      refresh();
    }
  }, [cache, refresh]);

  // Rounds for the filter, from the applications themselves (no extra
  // request, and it works for moderators as well as admins).
  const rounds = useMemo(() => {
    const byId = new Map();
    for (const app of applications) {
      if (app.round?._id) byId.set(app.round._id, app.round.name);
    }
    return [...byId].map(([id, name]) => ({ _id: id, name }));
  }, [applications]);

  const visible = useMemo(
    () =>
      applications.filter(
        (app) =>
          (!status || app.status === status) &&
          (!round || app.round?._id === round),
      ),
    [applications, status, round],
  );

  async function decide(id, decision) {
    setError("");
    setDeciding(id);
    try {
      const data = await apiFetch(`/api/admin/applications/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      });
      const updated = data.application;
      setApplications((prev) => {
        const next = prev.map((app) =>
          app._id === id
            ? { ...app, status: updated.status, updatedAt: updated.updatedAt }
            : app,
        );
        cache.list = next;
        return next;
      });
      const detail = cache.details.get(id);
      if (detail) cache.details.set(id, { ...detail, status: updated.status });
    } catch (err) {
      setError(err.message);
    } finally {
      setDeciding(null);
    }
  }

  const selected = applications.find((app) => app._id === selectedId) || null;

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
          alignItems: "center",
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
        {rounds.length > 1
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
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", gap: "0.4rem" }}
          disabled={refreshing}
          onClick={refresh}
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            style={
              refreshing ? { animation: "spin 1s linear infinite" } : undefined
            }
          />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
        <span className="muted" style={{ fontSize: "0.82rem" }}>
          {loading
            ? ""
            : `Showing ${visible.length} of ${applications.length}` +
              (fetchedAt
                ? ` · updated ${fetchedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : "")}
        </span>
      </div>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      {loading
        ? <p className="muted">Loading…</p>
        : visible.length === 0
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
                  {visible.map((app) => (
                    <tr
                      key={app._id}
                      style={{ borderBottom: "1px solid var(--border)" }}
                    >
                      <Td>
                        <button
                          type="button"
                          className="link"
                          onClick={() => setSelectedId(app._id)}
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
                          {[
                            ["accepted", "Accept"],
                            ["waitlisted", "Waitlist"],
                            ["rejected", "Reject"],
                          ].map(([decision, label]) => (
                            <SmallBtn
                              key={decision}
                              disabled={
                                deciding === app._id || app.status === decision
                              }
                              onClick={() => decide(app._id, decision)}
                            >
                              {label}
                            </SmallBtn>
                          ))}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}

      {selected
        ? <ApplicationDrawer
            summary={selected}
            cache={cache}
            onClose={() => setSelectedId(null)}
          />
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
function SmallBtn({ children, onClick, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "0.3rem 0.6rem",
        fontSize: "0.8rem",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
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

// Detail drawer for one application. The list only has the table's columns,
// so the full application (answers, its round's form) is fetched on open and
// cached; reopening it costs nothing. The backdrop is a real <button>
// (accessible) and Escape also closes it.
function ApplicationDrawer({ summary, cache, onClose }) {
  const [app, setApp] = useState(() => cache.details.get(summary._id) || null);
  const [error, setError] = useState("");

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const cached = cache.details.get(summary._id);
    if (cached) {
      setApp(cached);
      return;
    }
    setApp(null);
    let cancelled = false;
    apiFetch(`/api/admin/applications/${summary._id}`)
      .then((data) => {
        cache.details.set(summary._id, data.application);
        if (!cancelled) setApp(data.application);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [cache, summary._id]);

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
            {summary.name || summary.applicant?.name}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              color: "var(--muted)",
              display: "inline-flex",
              padding: 4,
            }}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <Detail label="Email" value={summary.applicant?.email} />
        <Detail label="Status" value={summary.status} />
        {error
          ? <div className="alert-error">{error}</div>
          : !app
            ? <p className="muted">Loading the application…</p>
            : <ApplicationDetails app={app} />}
      </div>
    </div>
  );
}

function ApplicationDetails({ app }) {
  return (
    <>
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
      <Detail label="Hardware" value={(app.hardwareSkills || []).join(", ")} />
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
      <CustomAnswers app={app} />
      {app.hasResume
        ? <div style={{ marginTop: "0.75rem" }}>
            <SignedLinkButton
              path={`/api/admin/applications/${app._id}/resume`}
            >
              View resume
            </SignedLinkButton>
          </div>
        : null}
    </>
  );
}

// Answers to the round's custom questions, labelled from its formConfig.
function CustomAnswers({ app }) {
  const fields = app.round?.formConfig || [];
  const answers = app.answers || {};
  if (!fields.length) return null;

  return (
    <div style={{ marginTop: "0.75rem" }}>
      {fields.map((field) => {
        const value = answers[field.key];
        if (field.type === "resume") {
          // Uploaded resumes open through "View resume" below. Imported
          // applications may carry an external link instead; only https
          // links are made clickable.
          if (app.hasResume || !isHttpsUrl(value)) return null;
          return (
            <div key={field.key} style={{ marginBottom: "0.6rem" }}>
              <DetailLabel>{plainText(field.label)}</DetailLabel>
              <a
                className="link"
                href={value}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open resume (external link)
              </a>
            </div>
          );
        }
        return (
          <Detail
            key={field.key}
            label={plainText(field.label)}
            value={formatAnswer(field, value)}
          />
        );
      })}
    </div>
  );
}

function isHttpsUrl(value) {
  return typeof value === "string" && /^https:\/\/\S+$/i.test(value);
}

function formatAnswer(field, value) {
  if (field.type === "checkbox") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (value === undefined || value === null) return "";
  return String(value);
}

function DetailLabel({ children }) {
  return (
    <div
      className="muted"
      style={{
        fontSize: "0.75rem",
        textTransform: "uppercase",
        letterSpacing: "0.03em",
      }}
    >
      {children}
    </div>
  );
}

function Detail({ label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div style={{ marginBottom: "0.6rem" }}>
      <DetailLabel>{label}</DetailLabel>
      <div>{String(value)}</div>
    </div>
  );
}
