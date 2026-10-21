"use client";

// The application form, in two modes:
//   - "account": a logged-in applicant's own application (drafts, edits,
//     status), at /dashboard/application.
//   - "public": applying without an account (admin setting), on the home
//     page. Adds an email field, has no drafts, and can't edit afterwards.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import Autocomplete from "@/components/Autocomplete";
import SignedLinkButton from "@/components/SignedLinkButton";
import TagAutocomplete from "@/components/TagAutocomplete";
import { apiFetch, apiUpload } from "@/lib/api";
import { config } from "@/lib/config";

const TSHIRT_SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
const EDUCATION_LEVELS = [
  "High School",
  "Undergraduate",
  "Graduate",
  "PhD",
  "Bootcamp",
  "Other",
];
const GENDERS = [
  "Man",
  "Woman",
  "Non-binary",
  "Prefer to self-describe",
  "Prefer not to say",
];

// Empty form shape.
function emptyForm() {
  return {
    email: "",
    name: "",
    phone: "",
    age: "",
    gender: "",
    pronouns: "",
    education: "",
    university: "",
    major: "",
    allergies: "",
    tshirtSize: "",
    socials: { linkedin: "", github: "", website: "", other: [] },
    experience: {
      attendedBefore: false,
      hackathonsAttended: 0,
      attendedThisBefore: false,
    },
    programmingSkills: [],
    hardwareSkills: [],
    hasResume: false,
    answers: {},
  };
}

export default function ApplicationForm({ mode = "account" }) {
  const isPublic = mode === "public";
  const [form, setForm] = useState(emptyForm());
  const [round, setRound] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submittedStatus, setSubmittedStatus] = useState(null);
  // Public mode: the address a finished submission was sent from, and whether
  // that address already has an account (then they should log in instead).
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [accountExists, setAccountExists] = useState(false);
  const resumeRef = useRef(null);

  useEffect(() => {
    if (isPublic) {
      apiFetch("/api/applications/public/round")
        .then((data) => setRound(data.round))
        .catch((err) => setError(err.message))
        .finally(() => setLoading(false));
      return;
    }
    apiFetch("/api/applications/me")
      .then((data) => {
        setRound(data.round);
        if (data.application) {
          const a = data.application;
          setSubmittedStatus(a.status);
          setForm({
            name: a.name || "",
            phone: a.phone || "",
            age: a.age || "",
            gender: a.gender || "",
            pronouns: a.pronouns || "",
            education: a.education || "",
            university: a.university || "",
            major: a.major || "",
            allergies: a.allergies || "",
            tshirtSize: a.tshirtSize || "",
            socials: {
              linkedin: a.socials?.linkedin || "",
              github: a.socials?.github || "",
              website: a.socials?.website || "",
              other: a.socials?.other || [],
            },
            experience: {
              attendedBefore: Boolean(a.experience?.attendedBefore),
              hackathonsAttended: a.experience?.hackathonsAttended || 0,
              attendedThisBefore: Boolean(a.experience?.attendedThisBefore),
            },
            programmingSkills: a.programmingSkills || [],
            hardwareSkills: a.hardwareSkills || [],
            hasResume: Boolean(a.hasResume),
            answers: a.answers || {},
          });
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [isPublic]);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  function setSocial(key, value) {
    setForm((f) => ({ ...f, socials: { ...f.socials, [key]: value } }));
  }
  function setExperience(key, value) {
    setForm((f) => ({ ...f, experience: { ...f.experience, [key]: value } }));
  }
  function setAnswer(key, value) {
    setForm((f) => ({ ...f, answers: { ...f.answers, [key]: value } }));
  }

  async function submit(status) {
    setError("");
    setSuccess("");
    setAccountExists(false);
    setSubmitting(true);

    if (status === "pending" && !form.name.trim()) {
      setError("Full name is required.");
      setSubmitting(false);
      return;
    }
    if (isPublic && !form.email.trim()) {
      setError("Email is required.");
      setSubmitting(false);
      return;
    }

    try {
      const fd = new FormData();
      fd.append("status", status);
      if (isPublic) {
        fd.append("email", form.email.trim());
      }
      fd.append("name", form.name);
      fd.append("phone", form.phone);
      fd.append("age", form.age === "" ? "" : String(form.age));
      fd.append("gender", form.gender);
      fd.append("pronouns", form.pronouns);
      fd.append("education", form.education);
      fd.append("university", form.university);
      fd.append("major", form.major);
      fd.append("allergies", form.allergies);
      fd.append("tshirtSize", form.tshirtSize);
      fd.append("socials", JSON.stringify(form.socials));
      fd.append("experience", JSON.stringify(form.experience));
      fd.append("programmingSkills", JSON.stringify(form.programmingSkills));
      fd.append("hardwareSkills", JSON.stringify(form.hardwareSkills));
      fd.append("answers", JSON.stringify(form.answers));

      const file = resumeRef.current?.files[0];
      if (file) {
        fd.append("resume", file);
      }

      if (isPublic) {
        await apiUpload("/api/applications/public", fd);
        setSubmittedEmail(form.email.trim());
        window.scrollTo(0, 0);
        return;
      }

      const data = await apiUpload("/api/applications", fd);
      setSubmittedStatus(data.application.status);
      setField("hasResume", Boolean(data.application.hasResume));
      setSuccess(
        status === "draft" ? "Draft saved." : "Application submitted!",
      );
    } catch (err) {
      setError(err.message);
      setAccountExists(err.data?.code === "ACCOUNT_EXISTS");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e) {
    e.preventDefault();
    submit("pending");
  }

  if (loading) {
    return <p className="muted">Loading…</p>;
  }

  if (isPublic && submittedEmail) {
    return (
      <div className="card" style={{ padding: "1.5rem" }}>
        <h1
          style={{
            fontSize: "1.4rem",
            fontWeight: 700,
            marginBottom: "0.5rem",
          }}
        >
          Application received!
        </h1>
        <p>
          Thanks for applying to {config.orgName}. We sent a confirmation to{" "}
          <strong>{submittedEmail}</strong>.
        </p>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          If you&apos;re accepted, we&apos;ll email you a link to set up your
          account, where you&apos;ll find your status and check-in QR code.
        </p>
      </div>
    );
  }

  if (!round) {
    return (
      <div>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            marginBottom: "0.5rem",
          }}
        >
          Application
        </h1>
        <div className="card" style={{ padding: "1.5rem" }}>
          <p className="muted">
            Applications aren&apos;t open right now. Check back soon.
          </p>
        </div>
      </div>
    );
  }

  // A resume question in the round's custom form replaces the built-in one.
  const resumeField = (round.formConfig || []).find((f) => f.type === "resume");

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        {isPublic ? `Apply to ${config.orgName}` : "Application"}
      </h1>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        {round.name}
        {submittedStatus ? ` · status: ${submittedStatus}` : ""}
      </p>
      {isPublic
        ? <p className="muted" style={{ marginBottom: "0.5rem" }}>
            Already have an account?{" "}
            <Link href="/login" className="link">
              Log in
            </Link>
          </p>
        : null}

      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}
      >
        <Section title="Personal">
          <Grid>
            {isPublic
              ? <Field label="Email" required>
                  <input
                    className="input"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(e) => setField("email", e.target.value)}
                    required
                  />
                </Field>
              : null}
            <Field label="Full name" required>
              <input
                className="input"
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                required
              />
            </Field>
            <Field label="Phone">
              <input
                className="input"
                type="tel"
                value={form.phone}
                onChange={(e) => setField("phone", e.target.value)}
              />
            </Field>
            <Field label="Age">
              <input
                className="input"
                type="number"
                min="0"
                value={form.age}
                onChange={(e) => setField("age", e.target.value)}
              />
            </Field>
            <Field label="Gender">
              <select
                className="select"
                value={form.gender}
                onChange={(e) => setField("gender", e.target.value)}
              >
                <option value="">Select…</option>
                {GENDERS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Pronouns">
              <input
                className="input"
                value={form.pronouns}
                onChange={(e) => setField("pronouns", e.target.value)}
                placeholder="e.g. she/her"
              />
            </Field>
          </Grid>
        </Section>

        <Section title="Education">
          <Grid>
            <Field label="Education level">
              <select
                className="select"
                value={form.education}
                onChange={(e) => setField("education", e.target.value)}
              >
                <option value="">Select…</option>
                {EDUCATION_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="University / School">
              <Autocomplete
                value={form.university}
                onChange={(v) => setField("university", v)}
                endpoint="/api/meta/colleges"
                placeholder="Start typing…"
              />
            </Field>
            <Field label="Major / Field of study">
              <input
                className="input"
                value={form.major}
                onChange={(e) => setField("major", e.target.value)}
              />
            </Field>
          </Grid>
        </Section>

        <Section title="Logistics">
          <Grid>
            <Field label="T-shirt size">
              <select
                className="select"
                value={form.tshirtSize}
                onChange={(e) => setField("tshirtSize", e.target.value)}
              >
                <option value="">Select…</option>
                {TSHIRT_SIZES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Dietary restrictions / allergies">
              <input
                className="input"
                value={form.allergies}
                onChange={(e) => setField("allergies", e.target.value)}
                placeholder="e.g. peanuts, vegetarian"
              />
            </Field>
          </Grid>
          {resumeField
            ? null
            : <Field label="Resume (PDF or Word, max 5 MB)">
                <ResumeInput
                  inputRef={resumeRef}
                  hasResume={!isPublic && form.hasResume}
                />
              </Field>}
        </Section>

        <Section title="Links">
          <Grid>
            <Field label="LinkedIn">
              <input
                className="input"
                value={form.socials.linkedin}
                onChange={(e) => setSocial("linkedin", e.target.value)}
                placeholder="https://linkedin.com/in/…"
              />
            </Field>
            <Field label="GitHub">
              <input
                className="input"
                value={form.socials.github}
                onChange={(e) => setSocial("github", e.target.value)}
                placeholder="https://github.com/…"
              />
            </Field>
            <Field label="Personal website">
              <input
                className="input"
                value={form.socials.website}
                onChange={(e) => setSocial("website", e.target.value)}
                placeholder="https://…"
              />
            </Field>
          </Grid>
        </Section>

        <Section title="Hackathon experience">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginBottom: "0.75rem",
            }}
          >
            <input
              type="checkbox"
              checked={form.experience.attendedBefore}
              onChange={(e) =>
                setExperience("attendedBefore", e.target.checked)
              }
            />
            I have attended a hackathon before
          </label>
          {form.experience.attendedBefore
            ? <Field label="How many hackathons have you attended?">
                <input
                  className="input"
                  type="number"
                  min="0"
                  style={{ maxWidth: 160 }}
                  value={form.experience.hackathonsAttended}
                  onChange={(e) =>
                    setExperience("hackathonsAttended", Number(e.target.value))
                  }
                />
              </Field>
            : null}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "0.75rem",
            }}
          >
            <input
              type="checkbox"
              checked={form.experience.attendedThisBefore}
              onChange={(e) =>
                setExperience("attendedThisBefore", e.target.checked)
              }
            />
            I have attended {config.orgName} before
          </label>
        </Section>

        {round.formConfig && round.formConfig.length > 0
          ? <Section title="Additional questions">
              <Grid>
                {round.formConfig.map((field) =>
                  field.type === "resume"
                    ? <Field
                        key={field.key}
                        label={field.label}
                        required={field.required}
                      >
                        <ResumeInput
                          inputRef={resumeRef}
                          hasResume={!isPublic && form.hasResume}
                          required={field.required && !form.hasResume}
                        />
                      </Field>
                    : <DynamicField
                        key={field.key}
                        field={field}
                        value={form.answers[field.key]}
                        onChange={(v) => setAnswer(field.key, v)}
                      />,
                )}
              </Grid>
            </Section>
          : null}

        <Section title="Skills">
          <Field label="Programming skills">
            <TagAutocomplete
              values={form.programmingSkills}
              onChange={(v) => setField("programmingSkills", v)}
              endpoint="/api/meta/skills/programming"
              placeholder="Search skills, or type your own and press Enter"
            />
          </Field>
          <Field label="Hardware skills">
            <TagAutocomplete
              values={form.hardwareSkills}
              onChange={(v) => setField("hardwareSkills", v)}
              endpoint="/api/meta/skills/hardware"
              placeholder="Search skills, or type your own and press Enter"
            />
          </Field>
        </Section>

        {error
          ? <div className="alert-error" role="alert">
              {error}
              {accountExists
                ? <>
                    {" "}
                    <Link href="/login" className="link">
                      Log in
                    </Link>
                  </>
                : null}
            </div>
          : null}
        {success ? <div className="alert-success">{success}</div> : null}

        <div style={{ display: "flex", gap: "0.75rem", maxWidth: 420 }}>
          {isPublic
            ? null
            : <button
                type="button"
                className="btn btn-ghost"
                disabled={submitting}
                onClick={() => submit("draft")}
              >
                Save draft
              </button>}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
          >
            {submitting ? "Submitting…" : "Submit application"}
          </button>
        </div>
      </form>
    </div>
  );
}

// The resume file picker, plus a link to the one already uploaded (logged-in
// applicants only: viewing goes through their authenticated resume endpoint).
function ResumeInput({ inputRef, hasResume, required }) {
  return (
    <>
      <input
        ref={inputRef}
        className="input"
        type="file"
        accept=".pdf,.doc,.docx"
        required={required}
      />
      {hasResume
        ? <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
            Current:{" "}
            <SignedLinkButton path="/api/applications/me/resume">
              view uploaded resume
            </SignedLinkButton>
          </div>
        : null}
    </>
  );
}

function Section({ title, children }) {
  return (
    <div className="card" style={{ padding: "1.25rem 1.5rem" }}>
      <h2
        style={{ fontSize: "1.02rem", fontWeight: 600, marginBottom: "1rem" }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Grid({ children }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        gap: "1rem",
      }}
    >
      {children}
    </div>
  );
}

function DynamicField({ field, value, onChange }) {
  if (field.type === "checkbox") {
    return (
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.label}
        {field.required
          ? <span style={{ color: "var(--danger)" }}> *</span>
          : null}
      </label>
    );
  }

  return (
    <Field label={field.label} required={field.required}>
      {field.type === "select"
        ? <select
            className="select"
            value={value || ""}
            required={field.required}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">Select…</option>
            {(field.options || []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        : field.type === "textarea"
          ? <textarea
              className="textarea"
              value={value || ""}
              required={field.required}
              onChange={(e) => onChange(e.target.value)}
            />
          : <input
              className="input"
              type={
                field.type === "number"
                  ? "number"
                  : field.type === "date"
                    ? "date"
                    : "text"
              }
              value={value || ""}
              required={field.required}
              onChange={(e) => onChange(e.target.value)}
            />}
    </Field>
  );
}

function Field({ label, required, children }) {
  // `children` is always a form control here, wrapped by the label for
  // association — but biome can't see that statically through the prop.
  return (
    <>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: children is always the form control */}
      <label style={{ display: "block" }}>
        <span className="field-label">
          {label}
          {required ? <span style={{ color: "var(--danger)" }}> *</span> : null}
        </span>
        {children}
      </label>
    </>
  );
}
