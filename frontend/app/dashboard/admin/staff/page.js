"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Moderators and admin only. Check-in page.
export default function StaffCheckInPage() {
    const user = useUser();
    const router = useRouter();
    
    useEffect(() => {
        if (user.role !== "moderator" && user.role !== "admin") router.replace("/dashboard");
    }, [user.role, router]);

    if (user.role !== "moderator" && user.role !== "admin") return null;

    return (
        <div>
            <h1 style={{fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem",}}>
                Staff Check-In
            </h1>

        <p
            className="muted"
            style={{ marginBottom: "1.5rem" }}
        >
            Search accepted applicants and mark them as checked in.
        </p>

        <CheckInManager />
        </div>
    );
}

function CheckInManager() {
const [applications, setApplications] = useState([]);
const [search, setSearch] = useState("");
const [loading, setLoading] = useState(true);
const [error, setError] = useState("");
const [checkingIn, setCheckingIn] = useState(null);

// Load all applications available to moderators/admins.
async function loadApplications() {
    setLoading(true);
    setError("");

    try {
        const data = await apiFetch("/api/admin/applications");

        const accepted = (data.applications || []).filter(
            (application) => application.status === "accepted"
        );

        setApplications(accepted);
    } catch (err) {
        setError(err.message);
        } finally {
        setLoading(false);
    }

}

useEffect(() => { loadApplications(); }, []);

/*
* Search locally because the existing applications endpoint
* does not expose a dedicated search endpoint.
*/
  const filteredApplications = applications.filter((application) => {
    const user = application.user;

    const name = (user?.name || "").toLowerCase();

    const email = (user?.email || "").toLowerCase();

    const query = search.toLowerCase().trim();

    return (
        !query ||
        name.includes(query) ||
        email.includes(query)
    );
  }
  );

    async function checkIn(application) {
    const userId = application.user?._id;

    if (!userId) {
    setError("This application does not have a valid user.");
    return;
    }

    setCheckingIn(userId);
    setError("");

    try {
    /*
    * Prevent double check-ins by checking the status before attempting to check in.
    */
    const status = await apiFetch(
        `/api/staff/checkin/${userId}`
    );

    if (status.checkedIn) {
        setError(
        "This applicant has already been checked in."
        );
        return;
    }

    await apiFetch("/api/staff/checkin", {
        method: "POST",
        body: JSON.stringify({ userId }),
    });

    await loadApplications();
    
    } catch (err) {
        setError(err.message);
        } finally {
        setCheckingIn(null);
    }
}


return (
    <div
    className="card"
    style={{ padding: "1.5rem" }}
    >
    <h2 style={{ fontSize: "1.05rem", fontWeight: 600, marginBottom: "0.25rem" }}>
        Accepted applicants
    </h2>

    <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>
        Search by applicant name or email, then mark them as checked in.
    </p>

  {error ? (
    <div
      className="alert-error"
      style={{ marginBottom: "1rem" }}
    >
      {error}
    </div>
  ) : null}

// SEARCH

  <div
    style={{
      display: "flex",
      gap: "0.5rem",
      marginBottom: "1.25rem",
    }}
  >
    <input
      className="input"
      placeholder="Search by name or email"
      value={search}
      onChange={(e) => setSearch(e.target.value)}
    />

    {search ? (
      <button
        type="button"
        className="btn btn-ghost"
        style={{
          width: "auto",
          whiteSpace: "nowrap",
        }}
        onClick={() => setSearch("")}
      >
        Clear
      </button>
    ) : null}
  </div>

// RESULTS

  {loading ? (
    <p className="muted">Loading…</p>
  ) : filteredApplications.length === 0 ? (
    <p className="muted">
      {search
        ? "No accepted applicants match your search."
        : "No accepted applicants found."}
    </p>
  ) : (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      {filteredApplications.map((application) => (
        <ApplicantRow
          key={application._id}
          application={application}
          checkingIn={
            checkingIn === application.user?._id
          }
          onCheckIn={() =>
            checkIn(application)
          }
        />
      ))}
    </div>
  )}
</div>

);
}

function ApplicantRow({ application, checkingIn, onCheckIn}) {
    const [checkIn, setCheckIn] = useState(null);
    const [loadingStatus, setLoadingStatus] = useState(true);

    const user = application.user;

    useEffect(() => {
        async function loadStatus() {
            if (!user?._id) {
                setLoadingStatus(false);
                return;
            }
            try {
                const data = await apiFetch(
                `/api/staff/checkin/${user._id}`
                );

                setCheckIn(data);
            } catch (err) {
                console.error(
                "Failed to load check-in status:",
                err
                );
            } finally {
                setLoadingStatus(false);
            }
        }
        loadStatus();
    }, [user?._id]);

const name = user?.name || "Unknown applicant";
const email = user?.email || "No email available";

function formatDate(value) {
    if (!value) return "Unknown";
    return new Date(value).toLocaleString();
}

function getStaffName(staff) {
    if (!staff) return "Unknown";

    if (typeof staff === "string") {
    return staff;
    }

    return (staff.name || "Unknown");
}

return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "1rem" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>


// APPLICANT INFO

    <div>
      <div
        style={{
          fontWeight: 600,
          marginBottom: 3,
        }}
      >
        {name}
      </div>

      <div
        className="muted"
        style={{ fontSize: "0.85rem" }}
      >
        {email}
      </div>

      <div
        className="muted"
        style={{
          fontSize: "0.78rem",
          marginTop: 4,
        }}
      >
        Application: accepted
      </div>
    </div>

// STATUS

    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
      }}
    >
      {loadingStatus ? (
        <span
          className="muted"
          style={{ fontSize: "0.85rem" }}
        >
          Checking status…
        </span>
      ) : checkIn?.checkedIn ? (
        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: "0.9rem",
            }}
          >
            ✓ Checked in
          </div>

          <div
            className="muted"
            style={{
              fontSize: "0.78rem",
              marginTop: 3,
            }}
          >
            {formatDate(checkIn.checkedInAt)}
          </div>

          <div
            className="muted"
            style={{
              fontSize: "0.78rem",
              marginTop: 2,
            }}
          >
            By: {getStaffName(checkIn.checkedInBy)}
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          style={{
            width: "auto",
            whiteSpace: "nowrap",
          }}
          disabled={checkingIn}
          onClick={onCheckIn}
        >
          {checkingIn
            ? "Checking in…"
            : "Check in"}
        </button>
      )}
    </div>
  </div>
</div>
);
}
