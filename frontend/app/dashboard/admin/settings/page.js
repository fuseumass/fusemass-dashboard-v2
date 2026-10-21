"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import BrandingFeaturesSettings from "@/components/BrandingFeaturesSettings";
import ReviewSettings from "@/components/ReviewSettings";
import WaitlistLimit from "@/components/WaitlistLimit";
import { apiFetch } from "@/lib/api";
import { useUser } from "@/lib/userContext";

// Admin-only: authentication settings, application rounds, and per-round form.
export default function SettingsPage() {
  const user = useUser();
  const router = useRouter();

  useEffect(() => {
    if (user.role !== "admin") router.replace("/dashboard");
  }, [user.role, router]);

  if (user.role !== "admin") return null;

  return (
    <div>
      <h1
        style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem" }}
      >
        Settings
      </h1>
      <p className="muted" style={{ marginBottom: "1.5rem" }}>
        Organization setup — visible to admins only.
      </p>
      <AuthSettings />
      <BrandingFeaturesSettings />
      <CheckInPopupSettings />
      <TeamSettings />
      <ReviewSettings />
      <EmailTemplateEditor />
      <RoundsManager />
    </div>
  );
}

var TEMPLATE_LABELS = {
  application_received: "Application Received",
  application_accepted: "Application Accepted",
  application_rejected: "Application Rejected",
  application_waitlisted: "Application Waitlisted",
  account_setup: "Account Setup (applied without an account)",
  verify_email: "Verify Email (sign-up)",
  checked_in: "Checked In",
};

var PLACEHOLDER_GUIDE = [
  "{{name}}",
  "{{status}}",
  "{{orgName}}",
  "{{websiteUrl}}",
  "{{discordUrl}}",
  "{{qrcode}}",
  "{{runOfShow}}",
  "{{setupUrl}}",
  "{{verifyUrl}}",
];

var QRCODE_TOKEN = /\{\{\s*qrcode\s*\}\}/;

// ---- Email template editor -------------------------------------------------

function EmailTemplateEditor() {
  const [templates, setTemplates] = useState([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState("");
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState("");
  const bodyRef = useRef(null);

  const loadTemplates = useCallback(() => {
    setLoading(true);
    setError("");

    apiFetch("/api/admin/email-templates")
      .then((data) => {
        const raw = data.templates || [];
        const order = [
          "application_received",
          "application_accepted",
          "application_rejected",
          "application_waitlisted",
          "checked_in",
        ];
        const sorted = [...raw].sort((a, b) => {
          const ai = order.indexOf(a.key);
          const bi = order.indexOf(b.key);
          const safeAi = ai === -1 ? 999 : ai;
          const safeBi = bi === -1 ? 999 : bi;
          if (safeAi !== safeBi) return safeAi - safeBi;
          return String(a.key).localeCompare(String(b.key));
        });

        setTemplates(sorted);
        if (sorted.length) {
          setSelectedKey(function selectExisting(prev) {
            const exists = sorted.some((template) => template.key === prev);
            return exists && prev ? prev : sorted[0].key;
          });
        } else {
          setSelectedKey("");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  const activeTemplate =
    templates.find((template) => template.key === selectedKey) || null;

  useEffect(() => {
    if (!activeTemplate) {
      setSubject("");
      setBody("");
      return;
    }
    setSubject(activeTemplate.subject || "");
    setBody(activeTemplate.body || "");
    setNotice("");
  }, [activeTemplate]);

  // Server-rendered preview of the unsaved draft: exactly what the email will
  // look like, with the admin's own QR code where {{qrcode}} is.
  useEffect(() => {
    if (!activeTemplate) {
      setPreview(null);
      return;
    }
    const handle = setTimeout(() => {
      apiFetch("/api/admin/email-templates/preview", {
        method: "POST",
        body: JSON.stringify({ subject, body }),
      })
        .then((data) => {
          setPreview(data);
          setPreviewError("");
        })
        .catch((err) => setPreviewError(err.message));
    }, 400);
    return () => clearTimeout(handle);
  }, [activeTemplate, subject, body]);

  // Put a placeholder at the cursor in the body.
  function insertToken(token) {
    const el = bodyRef.current;
    const start = el ? el.selectionStart : body.length;
    const end = el ? el.selectionEnd : body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  async function sendTest() {
    setTesting(true);
    setError("");
    setNotice("");
    try {
      const data = await apiFetch("/api/admin/email-templates/test", {
        method: "POST",
        body: JSON.stringify({ subject, body }),
      });
      setNotice(`Test email sent to ${data.sentTo}.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setTesting(false);
    }
  }

  async function saveTemplate() {
    if (!activeTemplate) return;
    setSaving(true);
    setError("");

    try {
      const data = await apiFetch(
        `/api/admin/email-templates/${activeTemplate._id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ subject: subject, body: body }),
        },
      );

      const updated = data.template;
      setTemplates((prev) =>
        prev.map((template) => {
          if (template._id === activeTemplate._id) {
            return updated;
          }
          return template;
        }),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const missingQr =
    activeTemplate?.key === "application_accepted" && !QRCODE_TOKEN.test(body);

  return (
    <div className="card" style={{ padding: "1.5rem", marginBottom: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.25rem",
        }}
      >
        Email templates
      </h2>
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        Edit the emails sent when someone applies, is accepted or rejected, and
        checks in at the event. The preview shows the real email, with your own
        QR code.
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {notice
        ? <div className="alert-success" style={{ marginBottom: "0.75rem" }}>
            {notice}
          </div>
        : null}

      {loading
        ? <p className="muted">Loading…</p>
        : !activeTemplate
          ? <p className="muted">No templates found.</p>
          : <>
              <div
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  marginBottom: "0.75rem",
                  flexWrap: "wrap",
                }}
              >
                {templates.map((template) => (
                  <button
                    key={template._id}
                    type="button"
                    className="btn btn-ghost"
                    style={{
                      width: "auto",
                      padding: "0.35rem 0.7rem",
                      borderColor:
                        selectedKey === template.key
                          ? "var(--brand)"
                          : undefined,
                    }}
                    onClick={() => setSelectedKey(template.key)}
                  >
                    {TEMPLATE_LABELS[template.key] || template.key}
                  </button>
                ))}
              </div>

              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                <span className="field-label">Subject</span>
                <input
                  className="input"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject"
                />
              </label>

              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                <span className="field-label">Body</span>
                <textarea
                  ref={bodyRef}
                  className="textarea"
                  style={{ minHeight: 140 }}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Email body"
                />
              </label>

              {missingQr
                ? <div
                    className="alert-error"
                    style={{ marginBottom: "0.75rem" }}
                  >
                    This acceptance email has no {"{{qrcode}}"}, so accepted
                    applicants won&apos;t get their check-in QR code.{" "}
                    <button
                      type="button"
                      className="link"
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                      }}
                      onClick={() => insertToken("{{qrcode}}")}
                    >
                      Insert it
                    </button>
                  </div>
                : null}

              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: 4,
                    fontSize: "0.9rem",
                  }}
                >
                  Placeholders
                </div>
                <div
                  className="muted"
                  style={{ fontSize: "0.82rem", marginBottom: 6 }}
                >
                  Click to insert at the cursor:
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {PLACEHOLDER_GUIDE.map((token) => (
                    <button
                      type="button"
                      key={token}
                      className="chip"
                      style={{ cursor: "pointer" }}
                      onClick={() => insertToken(token)}
                    >
                      {token}
                    </button>
                  ))}
                </div>
                <div
                  className="muted"
                  style={{ fontSize: "0.78rem", marginTop: 6 }}
                >
                  {"{{qrcode}}"} puts the recipient&apos;s check-in QR code
                  (SHA-256 of their email) right where you place it, in any
                  template; templates without it don&apos;t include one.{" "}
                  {"{{runOfShow}}"} lists the schedule (checked-in email).{" "}
                  {"{{websiteUrl}}"} and {"{{discordUrl}}"} come from the
                  server&apos;s ORG_WEBSITE_URL / ORG_DISCORD_URL.
                </div>
              </div>

              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "0.75rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: 4,
                    fontSize: "0.9rem",
                  }}
                >
                  Preview
                </div>
                {previewError
                  ? <p className="muted" style={{ fontSize: "0.85rem" }}>
                      Preview unavailable: {previewError}
                    </p>
                  : !preview
                    ? <p className="muted" style={{ fontSize: "0.85rem" }}>
                        Rendering…
                      </p>
                    : <>
                        <div style={{ fontSize: "0.9rem", marginBottom: 6 }}>
                          <strong>Subject:</strong> {preview.subject}
                        </div>
                        {/* Sandboxed: the HTML is escaped server-side, and the
                            iframe keeps any email styling off this page. */}
                        <iframe
                          title="Email preview"
                          sandbox=""
                          srcDoc={`<!doctype html><html><body style="margin:0;padding:12px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#171821;background:#fff">${preview.html}</body></html>`}
                          style={{
                            width: "100%",
                            height: preview.hasQrCode ? 460 : 240,
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            background: "#fff",
                          }}
                        />
                      </>}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ width: "auto" }}
                  onClick={saveTemplate}
                  disabled={saving}
                >
                  {saving ? "Saving..." : "Save template"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: "auto" }}
                  onClick={sendTest}
                  disabled={testing}
                >
                  {testing ? "Sending…" : "Send test email to me"}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ width: "auto" }}
                  onClick={loadTemplates}
                  disabled={saving}
                >
                  Reload
                </button>
              </div>
            </>}
    </div>
  );
}

// ---- Google OAuth toggle ---------------------------------------------------

function AuthSettings() {
  const [settings, setSettings] = useState(null);
  const [envAllowed, setEnvAllowed] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setEnvAllowed(data.googleEnvAllowed);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function toggle(key) {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: !settings[key] }),
      });
      setSettings(data.settings);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ padding: "1.5rem", marginBottom: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Authentication
      </h2>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {!settings
        ? <p className="muted">Loading…</p>
        : <div style={{ display: "grid", gap: "1rem" }}>
            <SettingToggle
              title="Accept applications without an account"
              description={
                settings.publicApplications
                  ? "On — the home page is the application form; accepted applicants get an email to set a password."
                  : "Off — applicants sign up and log in before applying."
              }
              on={settings.publicApplications}
              disabled={saving}
              onToggle={() => toggle("publicApplications")}
            />
            {envAllowed
              ? <SettingToggle
                  title="Sign in with Google"
                  description={
                    settings.googleAuthEnabled
                      ? "Enabled — applicants can use Google."
                      : "Disabled — hidden from login."
                  }
                  on={settings.googleAuthEnabled}
                  disabled={saving}
                  onToggle={() => toggle("googleAuthEnabled")}
                />
              : <p className="muted">
                  Google sign-in isn&apos;t configured on the server (missing
                  credentials or disabled by env), so there&apos;s nothing to
                  toggle for it yet.
                </p>}
          </div>}
    </div>
  );
}

// Largest team allowed (pending invites count while a team forms).
function TeamSettings() {
  const [size, setSize] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => setSize(String(data.settings.teamMaxSize || 4)))
      .catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ teamMaxSize: Number(size) }),
      });
      setSize(String(data.settings.teamMaxSize));
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={save}
      className="card"
      style={{ padding: "1.5rem", marginBottom: "1.5rem" }}
    >
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Teams
      </h2>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      <label className="field-label" htmlFor="team-max-size">
        Largest team (people, including pending invites)
      </label>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
        <input
          id="team-max-size"
          className="input"
          type="number"
          min={1}
          max={10}
          value={size}
          onChange={(e) => {
            setSize(e.target.value);
            setSaved(false);
          }}
          style={{ maxWidth: 100 }}
        />
        <button
          type="submit"
          className="btn btn-ghost"
          style={{ width: "auto" }}
          disabled={saving || !size}
        >
          Save
        </button>
        {saved ? <span className="muted">Saved.</span> : null}
      </div>
    </form>
  );
}

// What staff see in large type after each successful check-in.
function CheckInPopupSettings() {
  const [settings, setSettings] = useState(null);
  const [options, setOptions] = useState({});
  const [fields, setFields] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setOptions(data.checkInPopupFieldOptions || {});
        setFields(data.settings.checkInPopupFields || []);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function save(patchBody) {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(patchBody),
      });
      setSettings(data.settings);
      setFields(data.settings.checkInPopupFields || []);
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function toggleField(key, on) {
    // Keep the order the fields are listed in.
    const next = Object.keys(options).filter((k) =>
      k === key ? on : fields.includes(k),
    );
    setFields(next);
    setSaved(false);
  }

  return (
    <div className="card" style={{ padding: "1.5rem", marginBottom: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.75rem",
        }}
      >
        Check-in popup
      </h2>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {!settings
        ? <p className="muted">Loading…</p>
        : <>
            <SettingToggle
              title="Show a popup after each check-in"
              description={
                settings.checkInPopupEnabled
                  ? "On — staff see these details in large type after a successful scan."
                  : "Off — the check-in screen only shows the result banner."
              }
              on={settings.checkInPopupEnabled}
              disabled={saving}
              onToggle={() =>
                save({ checkInPopupEnabled: !settings.checkInPopupEnabled })
              }
            />
            <div style={{ opacity: settings.checkInPopupEnabled ? 1 : 0.5 }}>
              {[
                ["Standard fields", (key) => !key.startsWith("answers.")],
                ["Form questions", (key) => key.startsWith("answers.")],
              ].map(([heading, belongs]) => {
                const entries = Object.entries(options).filter(([key]) =>
                  belongs(key),
                );
                if (!entries.length) return null;
                return (
                  <div key={heading} style={{ marginTop: "1rem" }}>
                    <div className="field-label">{heading}</div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(220px, 1fr))",
                        gap: "0.35rem",
                      }}
                    >
                      {entries.map(([key, label]) => (
                        <label
                          key={key}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: "0.4rem",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={fields.includes(key)}
                            onChange={(e) => toggleField(key, e.target.checked)}
                            style={{ marginTop: 3 }}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              <div style={{ marginBottom: "0.75rem" }} />
            </div>
            <div
              style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}
            >
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                disabled={saving}
                onClick={() => save({ checkInPopupFields: fields })}
              >
                Save popup fields
              </button>
              {saved ? <span className="muted">Saved.</span> : null}
            </div>
          </>}
    </div>
  );
}

function SettingToggle({ title, description, on, disabled, onToggle }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
      }}
    >
      <div>
        <div style={{ fontWeight: 500 }}>{title}</div>
        <div className="muted" style={{ fontSize: "0.85rem" }}>
          {description}
        </div>
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        style={{ width: "auto", flexShrink: 0 }}
        disabled={disabled}
        onClick={onToggle}
      >
        {on ? "Turn off" : "Turn on"}
      </button>
    </div>
  );
}

// ---- Application rounds -----------------------------------------------------

function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
}

function RoundsManager() {
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    apiFetch("/api/admin/rounds")
      .then((data) => setRounds(data.rounds))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function createRound(e) {
    e.preventDefault();
    setError("");
    try {
      await apiFetch("/api/admin/rounds", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="card" style={{ padding: "1.5rem" }}>
      <h2
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          marginBottom: "0.25rem",
        }}
      >
        Application rounds
      </h2>
      <p
        className="muted"
        style={{ fontSize: "0.85rem", marginBottom: "1rem" }}
      >
        Create multiple cycles (e.g. Early, Regular, Late) and set when each
        opens and closes.
      </p>

      {error
        ? <div className="alert-error" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        : null}

      <form
        onSubmit={createRound}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem" }}
      >
        <input
          className="input"
          placeholder="New round name (e.g. Early Applications)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto", whiteSpace: "nowrap" }}
        >
          Add round
        </button>
      </form>

      {loading
        ? <p className="muted">Loading…</p>
        : rounds.length === 0
          ? <p className="muted">No rounds yet.</p>
          : <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.75rem",
              }}
            >
              {rounds.map((r) => (
                <RoundRow key={r._id} round={r} onChanged={load} />
              ))}
            </div>}
    </div>
  );
}

const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "checkbox",
  "date",
  "resume",
];

// How each type reads in the builder's dropdown.
const FIELD_TYPE_LABELS = {
  multiselect: "multiselect (checkboxes)",
  resume: "resume (file upload)",
};

const HAS_OPTIONS = ["select", "multiselect"];

// Built-in application questions (not part of formConfig) a round can make
// required. Keys match the backend's PROFILE_FIELD_LABELS.
const PROFILE_FIELDS = [
  ["phone", "Phone"],
  ["age", "Age"],
  ["gender", "Gender"],
  ["pronouns", "Pronouns"],
  ["education", "Education level"],
  ["university", "University / School"],
  ["major", "Major / Field of study"],
  ["tshirtSize", "T-shirt size"],
  ["allergies", "Dietary restrictions / allergies"],
  ["programmingSkills", "Programming skills"],
  ["hardwareSkills", "Hardware skills"],
];

function profileFromRound(round) {
  const p = round.profileFields || {};
  return {
    required: Array.isArray(p.required) ? p.required : [],
    education: (p.options?.education || []).join("\n"),
    gender: (p.options?.gender || []).join("\n"),
  };
}

function profileToPayload(profile) {
  const lines = (text) =>
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  const options = {};
  if (lines(profile.education).length)
    options.education = lines(profile.education);
  if (lines(profile.gender).length) options.gender = lines(profile.gender);
  return { required: profile.required, options };
}

function fieldFromConfig(f) {
  return {
    _uid: crypto.randomUUID(),
    key: f?.key || "",
    label: f?.label || "",
    type: FIELD_TYPES.includes(f?.type) ? f.type : "text",
    required: Boolean(f?.required),
    options: Array.isArray(f?.options) ? f.options : [],
    allowOther: Boolean(f?.allowOther),
    description: f?.description || "",
  };
}

function emptyField() {
  return fieldFromConfig(null);
}

function RoundRow({ round, onChanged }) {
  const [opensAt, setOpensAt] = useState(toLocalInput(round.opensAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(round.closesAt));
  const [showForm, setShowForm] = useState(false);
  const [profile, setProfile] = useState(() => profileFromRound(round));
  const [fields, setFields] = useState(
    (round.formConfig || []).map(fieldFromConfig),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function updateField(index, patchObj) {
    setFields((fs) =>
      fs.map((f, i) => (i === index ? { ...f, ...patchObj } : f)),
    );
  }
  function addField() {
    setFields((fs) => [...fs, emptyField()]);
  }
  function removeField(index) {
    setFields((fs) => fs.filter((_, i) => i !== index));
  }
  function moveField(index, dir) {
    setFields((fs) => {
      const target = index + dir;
      if (target < 0 || target >= fs.length) return fs;
      const next = [...fs];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function patch(body) {
    setSaving(true);
    setError("");
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveDates() {
    await patch({
      opensAt: opensAt ? new Date(opensAt).toISOString() : null,
      closesAt: closesAt ? new Date(closesAt).toISOString() : null,
    });
  }

  async function saveForm() {
    const payload = fields.map((f) => {
      const out = {
        key: f.key,
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options,
      };
      if (HAS_OPTIONS.includes(f.type)) out.allowOther = f.allowOther;
      if (f.description.trim()) out.description = f.description.trim();
      return out;
    });
    await patch({
      formConfig: payload,
      profileFields: profileToPayload(profile),
    });
  }

  async function remove() {
    if (!window.confirm(`Delete round "${round.name}"?`)) return;
    setSaving(true);
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "0.5rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontWeight: 600 }}>
          {round.name}{" "}
          <span
            className="muted"
            style={{ fontWeight: 400, fontSize: "0.82rem" }}
          >
            {round.isOpen ? "· open" : "· closed"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", padding: "0.35rem 0.7rem" }}
            disabled={saving}
            onClick={() => patch({ isOpen: !round.isOpen })}
          >
            {round.isOpen ? "Close" : "Open"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto", padding: "0.35rem 0.7rem" }}
            onClick={() => setShowForm((s) => !s)}
          >
            Edit form
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              width: "auto",
              padding: "0.35rem 0.7rem",
              color: "var(--destructive)",
            }}
            disabled={saving}
            onClick={remove}
          >
            Delete
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "0.75rem",
          marginTop: "0.75rem",
        }}
      >
        <label style={{ display: "block" }}>
          <span className="field-label">Opens</span>
          <input
            className="input"
            type="datetime-local"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Closes</span>
          <input
            className="input"
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </label>
        <div style={{ display: "flex", alignItems: "flex-end" }}>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ width: "auto" }}
            disabled={saving}
            onClick={saveDates}
          >
            Save dates
          </button>
        </div>
      </div>

      <WaitlistLimit
        key={round.waitlistAfterAccepted ?? "none"}
        round={round}
        onChanged={onChanged}
      />

      {showForm
        ? <div style={{ marginTop: "0.75rem" }}>
            <ProfileFieldsEditor profile={profile} onChange={setProfile} />
            <p
              className="muted"
              style={{ fontSize: "0.82rem", marginBottom: "0.75rem" }}
            >
              Extra questions applicants answer for this round, alongside the
              standard fields.
            </p>

            {fields.length === 0
              ? <p className="muted" style={{ marginBottom: "0.75rem" }}>
                  No extra fields yet.
                </p>
              : <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.75rem",
                    marginBottom: "0.75rem",
                  }}
                >
                  {fields.map((field, index) => (
                    <FormFieldEditor
                      key={field._uid}
                      field={field}
                      isFirst={index === 0}
                      isLast={index === fields.length - 1}
                      onChange={(patchObj) => updateField(index, patchObj)}
                      onMoveUp={() => moveField(index, -1)}
                      onMoveDown={() => moveField(index, 1)}
                      onRemove={() => removeField(index)}
                    />
                  ))}
                </div>}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                onClick={addField}
              >
                + Add field
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto" }}
                disabled={saving}
                onClick={saveForm}
              >
                Save form config
              </button>
            </div>
          </div>
        : null}

      {error
        ? <div className="alert-error" style={{ marginTop: "0.75rem" }}>
            {error}
          </div>
        : null}
    </div>
  );
}

// Settings for the standard questions every application has: which are
// required, and the choices for the education and gender dropdowns.
function ProfileFieldsEditor({ profile, onChange }) {
  function toggle(key, on) {
    const required = on
      ? [...profile.required, key]
      : profile.required.filter((k) => k !== key);
    onChange({ ...profile, required });
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.75rem",
        marginBottom: "0.75rem",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>
        Built-in questions
      </div>
      <p
        className="muted"
        style={{ fontSize: "0.82rem", marginBottom: "0.5rem" }}
      >
        Name (and email, without an account) are always required. Tick the
        others this round requires.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "0.3rem",
          marginBottom: "0.6rem",
        }}
      >
        {PROFILE_FIELDS.map(([key, label]) => (
          <label
            key={key}
            style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}
          >
            <input
              type="checkbox"
              checked={profile.required.includes(key)}
              onChange={(e) => toggle(key, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "0.5rem",
        }}
      >
        <label style={{ display: "block" }}>
          <span className="field-label">Education level choices</span>
          <textarea
            className="textarea"
            rows={4}
            value={profile.education}
            onChange={(e) =>
              onChange({ ...profile, education: e.target.value })
            }
            placeholder="One per line. Leave empty for the standard choices."
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Gender choices</span>
          <textarea
            className="textarea"
            rows={4}
            value={profile.gender}
            onChange={(e) => onChange({ ...profile, gender: e.target.value })}
            placeholder="One per line. Leave empty for the standard choices."
          />
        </label>
      </div>
    </div>
  );
}

function FormFieldEditor({
  field,
  isFirst,
  isLast,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove,
}) {
  // One option per line: options often contain commas themselves
  // ("No, I don't need meal accommodations."). The raw text is kept while
  // typing, so a new empty line isn't stripped before an option is typed on it.
  const [optionsText, setOptionsText] = useState(() =>
    (field.options || []).join("\n"),
  );

  function setOptionsFromText(text) {
    setOptionsText(text);
    const options = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({ options });
  }

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "0.75rem",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
          gap: "0.5rem",
        }}
      >
        <label style={{ display: "block" }}>
          <span className="field-label">Key</span>
          <input
            className="input"
            value={field.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="e.g. dietary"
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Label</span>
          <input
            className="input"
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="e.g. Dietary restrictions. Links: [text](https://…)"
          />
        </label>
        <label style={{ display: "block" }}>
          <span className="field-label">Type</span>
          <select
            className="select"
            value={field.type}
            onChange={(e) => onChange({ type: e.target.value })}
          >
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t] || t}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            paddingTop: "1.35rem",
          }}
        >
          <input
            type="checkbox"
            checked={field.required}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          Required
        </label>
      </div>

      {HAS_OPTIONS.includes(field.type)
        ? <label style={{ display: "block", marginTop: "0.5rem" }}>
            <span className="field-label">Options (one per line)</span>
            <textarea
              className="textarea"
              rows={Math.max(3, (field.options || []).length + 1)}
              value={optionsText}
              onChange={(e) => setOptionsFromText(e.target.value)}
              placeholder={"e.g.\nnone\nvegetarian\nvegan"}
            />
          </label>
        : null}

      {HAS_OPTIONS.includes(field.type)
        ? <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              marginTop: "0.5rem",
            }}
          >
            <input
              type="checkbox"
              checked={field.allowOther}
              onChange={(e) => onChange({ allowOther: e.target.checked })}
            />
            Allow &quot;Other&quot; with a text box
          </label>
        : null}

      <label style={{ display: "block", marginTop: "0.5rem" }}>
        <span className="field-label">Help text (optional)</span>
        <textarea
          className="textarea"
          rows={2}
          value={field.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Shown under the question. Links: [link text](https://…)"
        />
      </label>

      <div style={{ display: "flex", gap: 6, marginTop: "0.5rem" }}>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", padding: "0.25rem 0.6rem" }}
          disabled={isFirst}
          onClick={onMoveUp}
        >
          <ArrowUp size={14} aria-hidden="true" /> Move up
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: "auto", padding: "0.25rem 0.6rem" }}
          disabled={isLast}
          onClick={onMoveDown}
        >
          <ArrowDown size={14} aria-hidden="true" /> Move down
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          style={{
            width: "auto",
            padding: "0.25rem 0.6rem",
            color: "var(--destructive)",
          }}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
