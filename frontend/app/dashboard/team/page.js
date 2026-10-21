"use client";

import {
  Crown,
  Link2,
  LogOut,
  Mail,
  Pencil,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// The caller's hackathon team: start one, answer invites, invite teammates by
// email, and save the team's Devpost project link (which judging uses to
// match the project to the team).
export default function TeamPage() {
  const user = useUser();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    apiFetch("/api/teams/me")
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  async function act(label, path, options, done) {
    setError("");
    setNotice("");
    setBusy(label);
    try {
      const next = await apiFetch(path, options);
      setData(next);
      if (done) setNotice(done);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy("");
    }
  }

  if (!data && !error) return <p className="muted">Loading…</p>;

  const team = data?.team;
  const isLeader = team && String(team.leader?._id) === String(user._id);

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Team
      </h1>
      <p className="muted" style={{ marginBottom: "1.25rem" }}>
        Teams of up to {data?.maxSize || 4}. Add your Devpost project link once
        you&apos;ve submitted, so judges can match your project to your team.
      </p>

      {error
        ? <div
            className="alert-error"
            role="alert"
            style={{ marginBottom: "1rem" }}
          >
            {error}
          </div>
        : null}
      {notice
        ? <div className="alert-success" style={{ marginBottom: "1rem" }}>
            {notice}
          </div>
        : null}

      {data?.invites?.length
        ? <Invites
            invites={data.invites}
            busy={busy}
            act={act}
            onTeam={Boolean(team)}
          />
        : null}

      {team
        ? <TeamCard
            team={team}
            isLeader={isLeader}
            userId={user._id}
            busy={busy}
            act={act}
          />
        : data
          ? <CreateTeam busy={busy} act={act} />
          : null}
    </div>
  );
}

function Invites({ invites, busy, act, onTeam }) {
  return (
    <div
      className="card"
      style={{ padding: "1.25rem 1.5rem", marginBottom: "1rem" }}
    >
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Invites for you
      </h2>
      {onTeam
        ? <p
            className="muted"
            style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}
          >
            Leave your current team to accept one.
          </p>
        : null}
      <div style={{ display: "grid", gap: "0.6rem" }}>
        {invites.map((inv) => (
          <div
            key={inv.teamId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 220px" }}>
              <strong>{inv.teamName}</strong>
              <span className="muted">
                {" "}
                · {inv.members} member{inv.members === 1 ? "" : "s"}
                {inv.invitedBy ? ` · invited by ${inv.invitedBy}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ width: "auto" }}
              disabled={onTeam || busy === `accept-${inv.teamId}`}
              onClick={() =>
                act(
                  `accept-${inv.teamId}`,
                  `/api/teams/invites/${inv.teamId}/accept`,
                  { method: "POST" },
                  `You joined ${inv.teamName}.`,
                )
              }
            >
              Accept
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: "auto" }}
              disabled={busy === `decline-${inv.teamId}`}
              onClick={() =>
                act(
                  `decline-${inv.teamId}`,
                  `/api/teams/invites/${inv.teamId}/decline`,
                  {
                    method: "POST",
                  },
                )
              }
            >
              Decline
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CreateTeam({ busy, act }) {
  const [name, setName] = useState("");
  return (
    <form
      className="card"
      style={{ padding: "1.25rem 1.5rem" }}
      onSubmit={(e) => {
        e.preventDefault();
        act(
          "create",
          "/api/teams",
          { method: "POST", body: JSON.stringify({ name }) },
          "Team created. Invite your teammates below.",
        );
      }}
    >
      <h2
        style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.5rem" }}
      >
        Start a team
      </h2>
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "0.75rem" }}
      >
        Or ask a teammate to invite your email, and accept it here.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input
          className="input"
          aria-label="Team name"
          placeholder="Team name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: "1 1 240px" }}
          required
        />
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto" }}
          disabled={busy === "create" || name.trim().length < 2}
        >
          {busy === "create" ? "Creating…" : "Create team"}
        </button>
      </div>
    </form>
  );
}

function TeamCard({ team, isLeader, userId, busy, act }) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [devpost, setDevpost] = useState(team.devpostUrl || "");
  // Show the saved (normalized) link after a save.
  useEffect(() => {
    setDevpost(team.devpostUrl || "");
  }, [team.devpostUrl]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  const seats = team.maxSize - team.members.length - team.invites.length;

  return (
    <div className="card" style={{ padding: "1.25rem 1.5rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "1rem",
        }}
      >
        {renaming
          ? <form
              style={{
                display: "flex",
                gap: "0.5rem",
                flex: 1,
                flexWrap: "wrap",
              }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await act(
                    "rename",
                    "/api/teams/me",
                    { method: "PATCH", body: JSON.stringify({ name }) },
                    "Team renamed.",
                  )
                )
                  setRenaming(false);
              }}
            >
              <input
                className="input"
                aria-label="New team name"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                style={{ flex: "1 1 200px" }}
              />
              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: "auto" }}
                disabled={busy === "rename"}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                onClick={() => setRenaming(false)}
              >
                Cancel
              </button>
            </form>
          : <>
              <h2 style={{ fontSize: "1.2rem", fontWeight: 700, flex: 1 }}>
                {team.name}
              </h2>
              {isLeader
                ? <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: "auto", gap: "0.35rem" }}
                    onClick={() => setRenaming(true)}
                  >
                    <Pencil size={14} aria-hidden="true" /> Rename
                  </button>
                : null}
            </>}
      </div>

      <h3 className="field-label">Members</h3>
      <ul
        style={{
          listStyle: "none",
          padding: 0,
          margin: "0 0 1rem",
          display: "grid",
          gap: "0.4rem",
        }}
      >
        {team.members.map((m) => {
          const leader = String(m._id) === String(team.leader?._id);
          return (
            <li
              key={m._id}
              style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            >
              <span style={{ flex: 1 }}>
                <strong>{m.name}</strong>{" "}
                <span className="muted">{m.email}</span>
                {leader
                  ? <span
                      className="muted"
                      style={{ marginLeft: 6, fontSize: "0.8rem" }}
                    >
                      <Crown
                        size={13}
                        aria-hidden="true"
                        style={{ verticalAlign: "-2px" }}
                      />{" "}
                      leader
                    </span>
                  : null}
              </span>
              {isLeader && String(m._id) !== String(userId)
                ? <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label={`Remove ${m.name}`}
                    style={{ width: "auto", padding: "0.25rem 0.5rem" }}
                    disabled={busy === `remove-${m._id}`}
                    onClick={() => {
                      if (window.confirm(`Remove ${m.name} from the team?`)) {
                        act(
                          `remove-${m._id}`,
                          `/api/teams/me/members/${m._id}`,
                          { method: "DELETE" },
                        );
                      }
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                : null}
            </li>
          );
        })}
      </ul>

      {team.invites.length
        ? <>
            <h3 className="field-label">Waiting to accept</h3>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: "0 0 1rem",
                display: "grid",
                gap: "0.4rem",
              }}
            >
              {team.invites.map((inv) => (
                <li
                  key={inv.email}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <Mail size={14} aria-hidden="true" className="muted" />
                  <span style={{ flex: 1 }}>{inv.email}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: "auto", padding: "0.25rem 0.6rem" }}
                    disabled={busy === `cancel-${inv.email}`}
                    onClick={() =>
                      act(
                        `cancel-${inv.email}`,
                        `/api/teams/me/invites/${encodeURIComponent(inv.email)}`,
                        {
                          method: "DELETE",
                        },
                      )
                    }
                  >
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </>
        : null}

      <form
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginBottom: "1.25rem",
        }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await act(
              "invite",
              "/api/teams/me/invites",
              { method: "POST", body: JSON.stringify({ email: inviteEmail }) },
              `Invite sent to ${inviteEmail.trim()}.`,
            )
          ) {
            setInviteEmail("");
          }
        }}
      >
        <input
          className="input"
          type="email"
          aria-label="Teammate's email"
          placeholder="teammate@example.com"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          disabled={seats <= 0}
          style={{ flex: "1 1 240px" }}
          required
        />
        <button
          type="submit"
          className="btn btn-ghost"
          style={{ width: "auto", gap: "0.4rem" }}
          disabled={seats <= 0 || busy === "invite" || !inviteEmail.trim()}
        >
          <UserPlus size={16} aria-hidden="true" />
          {seats <= 0
            ? "Team is full"
            : busy === "invite"
              ? "Sending…"
              : "Invite"}
        </button>
      </form>

      <form
        style={{ marginBottom: "1.25rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          act(
            "devpost",
            "/api/teams/me",
            { method: "PATCH", body: JSON.stringify({ devpostUrl: devpost }) },
            devpost.trim() ? "Devpost link saved." : "Devpost link removed.",
          );
        }}
      >
        <label className="field-label" htmlFor="devpost-url">
          Devpost project link
        </label>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input
            id="devpost-url"
            className="input"
            placeholder="https://devpost.com/software/your-project"
            value={devpost}
            onChange={(e) => setDevpost(e.target.value)}
            style={{ flex: "1 1 280px" }}
          />
          <button
            type="submit"
            className="btn btn-ghost"
            style={{ width: "auto", gap: "0.4rem" }}
            disabled={
              busy === "devpost" || devpost.trim() === (team.devpostUrl || "")
            }
          >
            <Link2 size={16} aria-hidden="true" /> Save link
          </button>
        </div>
        {team.devpostUrl
          ? <p className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
              Saved:{" "}
              <a
                className="link"
                href={team.devpostUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {team.devpostUrl}
              </a>
            </p>
          : null}
      </form>

      <button
        type="button"
        className="btn btn-ghost"
        style={{ width: "auto", gap: "0.4rem", color: "var(--danger)" }}
        disabled={busy === "leave"}
        onClick={() => {
          const last = team.members.length === 1;
          if (
            window.confirm(
              last
                ? "You're the last member: leaving deletes the team. Continue?"
                : "Leave this team?",
            )
          ) {
            act(
              "leave",
              "/api/teams/me/leave",
              { method: "POST" },
              "You left the team.",
            );
          }
        }}
      >
        <LogOut size={16} aria-hidden="true" /> Leave team
      </button>
    </div>
  );
}
