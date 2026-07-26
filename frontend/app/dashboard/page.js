"use client";

// Simplistic dashboard — intentionally plain HTML. The team will design this.
//
// It serves two audiences based on the logged-in user's role:
//   - applicant: sees only the "Apply" flow (individual / group / team) and,
//     once applied, their application status.
//   - admin: sees the review panel to accept/reject applications.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch, clearToken, getToken } from "@/lib/api";

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    apiFetch("/api/auth/me")
      .then((data) => setUser(data.user))
      .catch((err) => {
        setError(err.message);
        clearToken();
        router.replace("/login");
      })
      .finally(() => setLoading(false));
  }, [router]);

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  if (loading) {
    return (
      <main>
        <p>Loading...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main>
        <p role="alert">{error}</p>
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>HackUMass Dashboard</h1>
        <p>
          Signed in as {user.name} ({user.role}){" "}
          <button type="button" onClick={handleLogout}>
            Log out
          </button>
        </p>
      </header>

      {user.role === "admin" ? <AdminPanel /> : <ApplicantPanel />}
    </main>
  );
}

// --- Applicant view ---------------------------------------------------------

function ApplicantPanel() {
  const [application, setApplication] = useState(null);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState("individual");
  const [teamName, setTeamName] = useState("");
  const [groupMembers, setGroupMembers] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch("/api/applications/me")
      .then((data) => setApplication(data.application))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function handleApply(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const body = { type };
      if (type === "team") {
        body.teamName = teamName;
      }
      if (type === "group") {
        body.groupMembers = groupMembers
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
      }
      const data = await apiFetch("/api/applications", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setApplication(data.application);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p>Loading your application...</p>;
  }

  // Already applied: show status only.
  if (application) {
    return (
      <section>
        <h2>Your application</h2>
        <p>Type: {application.type}</p>
        <p>Status: {application.status}</p>
      </section>
    );
  }

  // Not applied yet: the applicant only sees the Apply flow.
  return (
    <section>
      <h2>Apply to HackUMass</h2>
      <form onSubmit={handleApply}>
        <fieldset>
          <legend>Apply as</legend>
          <label>
            <input
              type="radio"
              name="type"
              value="individual"
              checked={type === "individual"}
              onChange={(e) => setType(e.target.value)}
            />
            Individual
          </label>
          <label>
            <input
              type="radio"
              name="type"
              value="group"
              checked={type === "group"}
              onChange={(e) => setType(e.target.value)}
            />
            Group
          </label>
          <label>
            <input
              type="radio"
              name="type"
              value="team"
              checked={type === "team"}
              onChange={(e) => setType(e.target.value)}
            />
            Team
          </label>
        </fieldset>

        {type === "team"
          ? <label>
              Team name
              <input
                type="text"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                required
              />
            </label>
          : null}

        {type === "group"
          ? <label>
              Group members (comma-separated emails)
              <input
                type="text"
                value={groupMembers}
                onChange={(e) => setGroupMembers(e.target.value)}
              />
            </label>
          : null}

        {error ? <p role="alert">{error}</p> : null}

        <button type="submit" disabled={submitting}>
          {submitting ? "Submitting..." : "Apply"}
        </button>
      </form>
    </section>
  );
}

// --- Admin view -------------------------------------------------------------

function AdminPanel() {
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    apiFetch("/api/admin/applications")
      .then((data) => setApplications(data.applications))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

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

  if (loading) {
    return <p>Loading applications...</p>;
  }

  return (
    <section>
      <h2>Applications</h2>
      {error ? <p role="alert">{error}</p> : null}
      {applications.length === 0 ? <p>No applications yet.</p> : null}
      <table>
        <thead>
          <tr>
            <th>Applicant</th>
            <th>Type</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((app) => (
            <tr key={app._id}>
              <td>{app.applicant ? app.applicant.name : "Unknown"}</td>
              <td>{app.type}</td>
              <td>{app.status}</td>
              <td>
                <button
                  type="button"
                  onClick={() => decide(app._id, "accepted")}
                >
                  Accept
                </button>
                <button
                  type="button"
                  onClick={() => decide(app._id, "rejected")}
                >
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
