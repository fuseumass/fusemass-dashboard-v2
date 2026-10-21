"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL, apiFetch, apiUpload } from "@/lib/api";
import { refreshFeatures } from "@/lib/features";

// Admin settings cards for B25 (module on/off switches) and B28 (runtime
// branding: name, colours, logos). Self-contained so the settings page only
// has to render <BrandingFeaturesSettings />.
//
// TODO(F12): the site does not read GET /api/meta/branding yet (the root
// layout still uses NEXT_PUBLIC_*). F12 adds that, plus a live preview and a
// contrast warning to the Branding card below.

const HEX = /^#[0-9a-fA-F]{6}$/;

const COLOR_FIELDS = [
  { key: "primaryColor", label: "Primary colour" },
  { key: "secondaryColor", label: "Secondary colour" },
  { key: "accentColor", label: "Accent colour (optional)" },
];

const IMAGE_SLOTS = [
  {
    slot: "logo",
    urlKey: "logoUrl",
    fileKey: "logoFile",
    label: "Logo",
    accept: "image/png,image/jpeg,image/webp",
  },
  {
    slot: "logo-dark",
    urlKey: "logoDarkUrl",
    fileKey: "logoDarkFile",
    label: "Logo for dark backgrounds",
    accept: "image/png,image/jpeg,image/webp",
  },
  {
    slot: "favicon",
    urlKey: "faviconUrl",
    fileKey: "faviconFile",
    label: "Favicon",
    accept: "image/png,image/jpeg,image/webp,.ico",
  },
];

// Uploaded images come back as root-relative API paths unless the server
// knows its public address; resolve those against the API.
function imageSrc(url) {
  if (!url) return "";
  return url.startsWith("/") ? `${API_URL}${url}` : url;
}

function formFromSettings(settings) {
  const b = settings.branding || {};
  return {
    orgName: b.orgName || "",
    primaryColor: b.primaryColor || "",
    secondaryColor: b.secondaryColor || "",
    accentColor: b.accentColor || "",
    logoUrl: b.logoUrl || "",
    logoDarkUrl: b.logoDarkUrl || "",
    faviconUrl: b.faviconUrl || "",
  };
}

export default function BrandingFeaturesSettings() {
  return (
    <>
      <FeatureSwitches />
      <BrandingCard />
    </>
  );
}

// ---- Modules on/off (B25) ---------------------------------------------------

function FeatureSwitches() {
  const [settings, setSettings] = useState(null);
  const [options, setOptions] = useState([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setOptions(data.featureOptions || []);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function toggle(key, nowOn) {
    setSaving(true);
    setError("");
    try {
      const data = await apiFetch("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({ features: { [key]: !nowOn } }),
      });
      setSettings(data.settings);
      refreshFeatures();
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
          marginBottom: "0.25rem",
        }}
      >
        Modules
      </h2>
      <p className="muted" style={{ marginBottom: "0.75rem" }}>
        A module that is switched off disappears from the menu and its pages
        stop working for everyone, admins included. Switches for modules that
        aren&apos;t built yet take effect when those modules arrive.
      </p>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {!settings
        ? <p className="muted">Loading…</p>
        : <div style={{ display: "grid", gap: "1rem" }}>
            {options.map((option) => {
              const on =
                !settings.features || settings.features[option.key] !== false;
              return (
                <div
                  key={option.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "1rem",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 500 }}>{option.label}</div>
                    <div className="muted" style={{ fontSize: "0.85rem" }}>
                      {on ? "On" : "Off — hidden and unavailable"}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: "auto", flexShrink: 0 }}
                    disabled={saving}
                    onClick={() => toggle(option.key, on)}
                  >
                    {on ? "Turn off" : "Turn on"}
                  </button>
                </div>
              );
            })}
          </div>}
    </div>
  );
}

// ---- Branding (B28) ----------------------------------------------------------

function BrandingCard() {
  const [settings, setSettings] = useState(null);
  const [effective, setEffective] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/settings")
      .then((data) => {
        setSettings(data.settings);
        setEffective(data.effectiveBranding);
        setDefaults(data.brandingDefaults);
        setUploadsEnabled(Boolean(data.imageUploadsEnabled));
        setForm(formFromSettings(data.settings));
      })
      .catch((err) => setError(err.message));
  }, []);

  const setField = useCallback((key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  // Adopt the server's answer after any save, upload or removal.
  function adopt(data) {
    setSettings(data.settings);
    setEffective(data.effectiveBranding);
    setForm(formFromSettings(data.settings));
  }

  const colorErrors = {};
  if (form) {
    for (const field of COLOR_FIELDS) {
      const value = form[field.key].trim();
      if (value && !HEX.test(value)) {
        colorErrors[field.key] = "Use the form #RRGGBB, for example #4f46e5.";
      }
    }
  }
  const hasErrors = Object.keys(colorErrors).length > 0;

  async function save(e) {
    e.preventDefault();
    if (hasErrors) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const branding = {};
      for (const [key, value] of Object.entries(form)) {
        branding[key] = value.trim();
      }
      adopt(
        await apiFetch("/api/admin/settings", {
          method: "PATCH",
          body: JSON.stringify({ branding }),
        }),
      );
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(slot, file) {
    if (!file) return;
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      const body = new FormData();
      body.append("file", file);
      adopt(
        await apiUpload(`/api/admin/branding/${slot}`, body, {
          method: "PUT",
        }),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(slot) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      adopt(
        await apiFetch(`/api/admin/branding/${slot}`, { method: "DELETE" }),
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
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
          marginBottom: "0.25rem",
        }}
      >
        Branding
      </h2>
      <p className="muted" style={{ marginBottom: "0.75rem" }}>
        Leave a field empty to use the server&apos;s default.
      </p>
      {error
        ? <div className="alert-error" style={{ marginBottom: "0.75rem" }}>
            {error}
          </div>
        : null}
      {!form || !settings || !effective || !defaults
        ? <p className="muted">Loading…</p>
        : <div style={{ display: "grid", gap: "1rem" }}>
            <div>
              <label className="field-label" htmlFor="brand-org-name">
                Name
              </label>
              <input
                id="brand-org-name"
                className="input"
                type="text"
                maxLength={80}
                value={form.orgName}
                placeholder={defaults.orgName}
                onChange={(e) => setField("orgName", e.target.value)}
              />
            </div>

            {COLOR_FIELDS.map((field) => {
              const shown = HEX.test(form[field.key])
                ? form[field.key]
                : effective[field.key] || defaults[field.key] || "#000000";
              return (
                <div key={field.key}>
                  <label className="field-label" htmlFor={`brand-${field.key}`}>
                    {field.label}
                  </label>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.5rem",
                      alignItems: "center",
                    }}
                  >
                    <input
                      type="color"
                      aria-label={`${field.label} picker`}
                      value={HEX.test(shown) ? shown.toLowerCase() : "#000000"}
                      onChange={(e) => setField(field.key, e.target.value)}
                      style={{ width: 44, height: 38, flexShrink: 0 }}
                    />
                    <input
                      id={`brand-${field.key}`}
                      className="input"
                      type="text"
                      value={form[field.key]}
                      placeholder={defaults[field.key] || "Not set"}
                      spellCheck={false}
                      aria-invalid={colorErrors[field.key] ? "true" : "false"}
                      onChange={(e) => setField(field.key, e.target.value)}
                      style={{ maxWidth: 160 }}
                    />
                  </div>
                  {colorErrors[field.key]
                    ? <div
                        role="alert"
                        style={{
                          color: "var(--danger)",
                          fontSize: "0.82rem",
                          marginTop: 4,
                        }}
                      >
                        {colorErrors[field.key]}
                      </div>
                    : null}
                </div>
              );
            })}

            {IMAGE_SLOTS.map((item) => {
              const current = effective[item.urlKey];
              const hasUpload = Boolean(settings.branding?.[item.fileKey]);
              return (
                <div key={item.slot}>
                  <label className="field-label" htmlFor={`brand-${item.slot}`}>
                    {item.label}
                  </label>
                  <div
                    style={{
                      display: "flex",
                      gap: "0.75rem",
                      alignItems: "center",
                      marginBottom: "0.5rem",
                    }}
                  >
                    {current
                      ? // biome-ignore lint/performance/noImgElement: admin-configured logo, not a build-time asset
                        <img
                          src={imageSrc(current)}
                          alt={`Current ${item.label.toLowerCase()}`}
                          style={{
                            height: 40,
                            maxWidth: 160,
                            objectFit: "contain",
                            background: "var(--background)",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            padding: 4,
                          }}
                        />
                      : <span className="muted" style={{ fontSize: "0.85rem" }}>
                          None set
                        </span>}
                    <input
                      id={`brand-${item.slot}`}
                      type="file"
                      accept={item.accept}
                      disabled={busy || !uploadsEnabled}
                      onChange={(e) => {
                        upload(item.slot, e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    {hasUpload || form[item.urlKey]
                      ? <button
                          type="button"
                          className="btn btn-ghost"
                          style={{ width: "auto" }}
                          disabled={busy}
                          onClick={() => remove(item.slot)}
                        >
                          Remove
                        </button>
                      : null}
                  </div>
                  <input
                    className="input"
                    type="url"
                    aria-label={`${item.label} URL`}
                    value={form[item.urlKey]}
                    placeholder="…or paste an https:// image address"
                    onChange={(e) => setField(item.urlKey, e.target.value)}
                  />
                </div>
              );
            })}
            {uploadsEnabled
              ? <p className="muted" style={{ fontSize: "0.85rem" }}>
                  PNG, JPEG or WebP up to 1 MB (the favicon may also be an
                  .ico). SVG isn&apos;t accepted.
                </p>
              : <p className="muted" style={{ fontSize: "0.85rem" }}>
                  Image storage isn&apos;t set up on the server, so uploads are
                  unavailable. Paste an https:// image address instead.
                </p>}

            <div
              style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}
            >
              <button
                type="submit"
                className="btn btn-primary"
                style={{ width: "auto" }}
                disabled={busy || hasErrors}
              >
                {busy ? "Saving…" : "Save branding"}
              </button>
              {saved ? <span className="muted">Saved.</span> : null}
            </div>
          </div>}
    </form>
  );
}
