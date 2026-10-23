"use client";

import { Ban, RefreshCw, RotateCcw, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

const FILTERS = [
  { key: "", label: "All" },
  { key: "failed", label: "Failed" },
  { key: "retrying", label: "Retrying" },
  { key: "queued", label: "Queued" },
  { key: "sent", label: "Sent" },
  { key: "cancelled", label: "Cancelled" },
];

// What the button on a row does, by the backend's `resendMode`.
const ACTIONS = {
  retry: "Retry now",
  send_now: "Send now",
  again: "Send again",
  reissue: "Send a new link",
};

function when(value) {
  return value ? new Date(value).toLocaleString() : "—";
}

// Every email the server sent or tried to send (admins only): failures first
// in mind, with retry, resend and cancel, plus "resend acceptance emails" for
// people accepted before QR codes shipped.
export default function OutboxPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("failed");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [acceptance, setAcceptance] = useState(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page) });
    if (filter) params.set("status", filter);
    if (query.trim()) params.set("q", query.trim());
    return apiFetch(`/api/admin/outbox?${params}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [filter, query, page]);

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
    else load();
  }, [isAdmin, router, load]);

  if (!isAdmin) return null;

  // Run an action, then refresh the list. Failures (like a resend that fails
  // again) come back as errors with the reason.
  async function run(label, request) {
    setError("");
    setNotice("");
    setBusy(label);
    try {
      const result = await request();
      await load();
      return result;
    } catch (err) {
      setError(err.message);
      await load();
      return null;
    } finally {
      setBusy("");
    }
  }

  async function rowAction(email) {
    const body = {};
    if (email.status === "sent") {
      const ok = window.confirm(
        `This email already went out to ${email.to}. Send another copy?`,
      );
      if (!ok) return;
      body.again = true;
    }
    const result = await run(email._id, () =>
      apiFetch(`/api/admin/outbox/${email._id}/resend`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    if (result) setNotice(`Sent to ${email.to}.`);
  }

  async function cancel(email) {
    await run(email._id, () =>
      apiFetch(`/api/admin/outbox/${email._id}/cancel`, { method: "POST" }),
    );
  }

  async function retryAll() {
    const result = await run("retry-all", () =>
      apiFetch("/api/admin/outbox/retry-failed", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (result)
      setNotice(
        result.reissued
          ? `${result.requeued} failed emails queued to retry. ${result.reissued} new account setup links sent.`
          : `${result.requeued} failed emails queued to retry.`,
      );
  }

  async function previewAcceptance() {
    const result = await run("acceptance", () =>
      apiFetch("/api/admin/outbox/resend-acceptance", {
        method: "POST",
        body: JSON.stringify({ dryRun: true }),
      }),
    );
    if (result) setAcceptance(result);
  }

  async function sendAcceptance() {
    const result = await run("acceptance", () =>
      apiFetch("/api/admin/outbox/resend-acceptance", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (result) {
      setAcceptance(null);
      setNotice(
        `${result.queued} acceptance emails queued. They send one at a time.`,
      );
    }
  }

  const counts = data?.counts;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Email outbox
      </h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        {data
          ? `${data.committedLast24h} emails sent or waiting in the last 24 hours (limit ${data.dailyLimit || "none"}).`
          : "Every email the server sent or tried to send."}
        {data && !data.smtpConfigured
          ? " Email isn't configured on the server, so nothing is being sent."
          : ""}
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}
      {notice
        ? <div className="alert-success" style={{ marginBottom: "1rem" }}>
            {notice}
          </div>
        : null}

      <div
        className="card"
        style={{ padding: "1rem 1.25rem", marginBottom: "1rem" }}
      >
        <strong>Resend acceptance emails</strong>
        <p
          className="muted"
          style={{ fontSize: "0.9rem", margin: "0.25rem 0" }}
        >
          For people accepted before check-in QR codes shipped, or while email
          was down. Skips anyone the outbox already shows a sent acceptance
          email for.
        </p>
        {acceptance
          ? <div>
              <p style={{ margin: "0.5rem 0" }}>
                {acceptance.recipients} of {acceptance.inSegment} accepted
                applicants would get one
                {acceptance.skippedAlreadySent
                  ? ` (${acceptance.skippedAlreadySent} already received it)`
                  : ""}
                .
              </p>
              {acceptance.warnings.map((w) => (
                <div
                  key={w}
                  className="alert-error"
                  style={{ marginBottom: "0.5rem" }}
                >
                  {w}
                </div>
              ))}
              {acceptance.overLimit
                ? <div
                    className="alert-error"
                    style={{ marginBottom: "0.5rem" }}
                  >
                    That is over the daily sending limit, so the server will
                    refuse it. Send fewer, or wait.
                  </div>
                : null}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "auto", gap: "0.4rem" }}
                  disabled={
                    busy === "acceptance" ||
                    !acceptance.recipients ||
                    acceptance.overLimit
                  }
                  onClick={sendAcceptance}
                >
                  <Send size={16} aria-hidden="true" /> Send{" "}
                  {acceptance.recipients}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: "auto" }}
                  onClick={() => setAcceptance(null)}
                >
                  Not now
                </button>
              </div>
            </div>
          : <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto", gap: "0.4rem", marginTop: "0.5rem" }}
              disabled={busy === "acceptance"}
              onClick={previewAcceptance}
            >
              <Send size={16} aria-hidden="true" /> Check who would get one
            </button>}
      </div>

      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`btn ${filter === f.key ? "btn-primary" : "btn-ghost"}`}
            style={{ width: "auto", padding: "0.4rem 0.8rem" }}
            onClick={() => {
              setFilter(f.key);
              setPage(1);
            }}
          >
            {f.label}
            {counts && f.key && counts[f.key] !== undefined
              ? ` (${counts[f.key]})`
              : ""}
          </button>
        ))}
        <input
          className="input"
          aria-label="Search by address"
          placeholder="Search by address"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          style={{ maxWidth: 240 }}
        />
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", gap: "0.4rem" }}
          onClick={load}
        >
          <RefreshCw size={16} aria-hidden="true" /> Refresh
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", gap: "0.4rem" }}
          disabled={busy === "retry-all" || !counts?.failed}
          onClick={retryAll}
        >
          <RotateCcw size={16} aria-hidden="true" /> Retry all failed
        </button>
      </div>

      {!data
        ? <p className="muted">Loading…</p>
        : data.emails.length === 0
          ? <div className="card" style={{ padding: "1.5rem" }}>
              <p className="muted">Nothing here.</p>
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
                    <th style={{ padding: "0.75rem 1rem" }}>To</th>
                    <th style={{ padding: "0.75rem 1rem" }}>Email</th>
                    <th style={{ padding: "0.75rem 1rem" }}>Status</th>
                    <th style={{ padding: "0.75rem 1rem" }} />
                  </tr>
                </thead>
                <tbody>
                  {data.emails.map((email) => (
                    <tr
                      key={email._id}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        verticalAlign: "top",
                      }}
                    >
                      <td style={{ padding: "0.75rem 1rem" }}>{email.to}</td>
                      <td style={{ padding: "0.75rem 1rem" }}>
                        <div>{email.subject || email.templateKey}</div>
                        <div className="muted" style={{ fontSize: "0.78rem" }}>
                          {email.templateKey} · {email.category}
                        </div>
                      </td>
                      <td style={{ padding: "0.75rem 1rem" }}>
                        <div style={{ fontWeight: 600 }}>
                          {email.sending ? "sending" : email.status}
                          {email.status === "queued" && email.attempts
                            ? " (retrying)"
                            : ""}
                        </div>
                        <div className="muted" style={{ fontSize: "0.78rem" }}>
                          {email.status === "sent"
                            ? `Sent ${when(email.sentAt)}`
                            : email.status === "queued"
                              ? `Next try ${when(email.nextAttemptAt)}`
                              : `Tried ${email.attempts} time${email.attempts === 1 ? "" : "s"}`}
                        </div>
                        {email.lastError
                          ? <div
                              style={{
                                fontSize: "0.78rem",
                                color: "var(--danger, #b42318)",
                                overflowWrap: "anywhere",
                              }}
                            >
                              {email.lastError}
                            </div>
                          : null}
                      </td>
                      <td
                        style={{
                          padding: "0.75rem 1rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {ACTIONS[email.resendMode]
                          ? <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ width: "auto", gap: "0.4rem" }}
                              disabled={busy === email._id}
                              onClick={() => rowAction(email)}
                            >
                              <Send size={14} aria-hidden="true" />{" "}
                              {ACTIONS[email.resendMode]}
                            </button>
                          : email.resendNote
                            ? <span
                                className="muted"
                                style={{
                                  fontSize: "0.78rem",
                                  whiteSpace: "normal",
                                }}
                              >
                                {email.resendNote}
                              </span>
                            : null}
                        {email.status === "queued" && !email.sending
                          ? <button
                              type="button"
                              className="btn btn-ghost"
                              style={{
                                width: "auto",
                                gap: "0.4rem",
                                marginLeft: "0.4rem",
                              }}
                              disabled={busy === email._id}
                              onClick={() => cancel(email)}
                            >
                              <Ban size={14} aria-hidden="true" /> Cancel
                            </button>
                          : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>}

      {data && pages > 1
        ? <div
            style={{
              display: "flex",
              gap: "0.5rem",
              alignItems: "center",
              marginTop: "1rem",
            }}
          >
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto" }}
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <span className="muted">
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto" }}
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        : null}
    </div>
  );
}
