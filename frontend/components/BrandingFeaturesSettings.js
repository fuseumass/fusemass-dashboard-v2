"use client";

import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CardLoading,
  Field,
  SettingRow,
  SettingsCard,
} from "@/components/SettingsParts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { API_URL, apiFetch, apiUpload } from "@/lib/api";
import { readableOn, refreshBranding } from "@/lib/branding";
import { refreshFeatures } from "@/lib/features";
import { notifySuccess } from "@/lib/notify";
import { cn } from "@/lib/utils";

// Admin settings cards for B25 (module on/off switches) and B28/F12 (runtime
// branding: name, colours, logos). The settings page renders the two cards
// separately; the default export renders both.

const HEX = /^#[0-9a-fA-F]{6}$/;

const COLOR_FIELDS = [
  {
    key: "primaryColor",
    label: "Primary colour",
    hint: "Buttons, the active menu item, focus rings and links.",
  },
  {
    key: "secondaryColor",
    label: "Secondary colour",
    hint: "Header bars and dark accents.",
  },
  {
    key: "accentColor",
    label: "Accent colour",
    hint: "Optional highlights. Follows the primary colour when empty.",
  },
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

// WCAG relative luminance and contrast ratio, for the "text on this colour" note.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function sameColor(a, b) {
  return (a || "").trim().toLowerCase() === (b || "").trim().toLowerCase();
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

export function FeatureSwitches() {
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
    <SettingsCard
      title="Modules"
      description="A module that is switched off disappears from the menu and its pages stop working for everyone, admins included. Switches for modules that are not built yet take effect when those modules arrive."
      error={error}
    >
      {!settings
        ? <CardLoading rows={3} />
        : <div className="space-y-4">
            {options.map((option, index) => {
              const on =
                !settings.features || settings.features[option.key] !== false;
              return (
                <div key={option.key} className="space-y-4">
                  {index > 0 ? <Separator /> : null}
                  <SettingRow
                    id={`feature-${option.key}`}
                    title={option.label}
                    description={
                      on
                        ? undefined
                        : "Off. Hidden from the menu and unavailable."
                    }
                    checked={on}
                    disabled={saving}
                    onCheckedChange={() => toggle(option.key, on)}
                  />
                </div>
              );
            })}
          </div>}
    </SettingsCard>
  );
}

// ---- Branding (B28, F12) ------------------------------------------------------

function ColorField({ field, value, error, shown, onChange, onReset }) {
  const text = readableOn(shown);
  const ratio = contrastRatio(shown, text);
  const textName = text === "#ffffff" ? "white" : "dark";
  return (
    <div className="grid gap-2">
      <Label htmlFor={`brand-${field.key}`}>{field.label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="color"
          aria-label={`${field.label} picker`}
          value={HEX.test(shown) ? shown.toLowerCase() : "#000000"}
          onChange={(e) => onChange(e.target.value)}
          className="size-9 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
        />
        <Input
          id={`brand-${field.key}`}
          type="text"
          value={value}
          placeholder={shown}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? "true" : "false"}
          onChange={(e) => onChange(e.target.value)}
          className="w-32 font-mono"
        />
        {value
          ? <Button type="button" variant="ghost" size="sm" onClick={onReset}>
              Use default
            </Button>
          : null}
      </div>
      {error
        ? <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        : <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{field.hint}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1.5",
                ratio < 4.5 && "text-warning",
              )}
            >
              <span
                className="inline-flex size-4 items-center justify-center rounded-sm border border-border text-[0.6rem] font-semibold"
                style={{ backgroundColor: shown, color: text }}
                aria-hidden="true"
              >
                A
              </span>
              Text on it will be {textName} ({ratio.toFixed(1)}:1
              {ratio < 4.5 ? ", low contrast" : ""}).
            </span>
          </p>}
    </div>
  );
}

// A small mock of the app, drawn with the unsaved colours.
function BrandPreview({ name, primary, secondary, accent, logo }) {
  const vars = {
    "--brand": primary,
    "--brand-foreground": readableOn(primary),
    "--brand-secondary": secondary,
    "--brand-secondary-foreground": readableOn(secondary),
    "--brand-accent": accent,
    "--primary": primary,
    "--primary-foreground": readableOn(primary),
    "--ring": primary,
  };
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-background text-foreground [--link:var(--brand)] dark:[--link:color-mix(in_oklab,var(--brand)_55%,white)]"
      style={vars}
      role="img"
      aria-label="Preview of the dashboard with these colours"
    >
      <div className="flex items-center gap-2 bg-brand-secondary px-4 py-2.5 text-sm font-semibold text-brand-secondary-foreground">
        {logo
          ? // biome-ignore lint/performance/noImgElement: admin-configured logo, not a build-time asset
            <img src={logo} alt="" className="h-5 max-w-24 object-contain" />
          : <span className="size-5 rounded-sm bg-brand" aria-hidden="true" />}
        <span className="truncate">{name}</span>
      </div>
      <div className="grid sm:grid-cols-[10rem_1fr]">
        <div className="space-y-1 border-b border-border p-3 text-sm sm:border-r sm:border-b-0">
          <div className="rounded-md bg-brand/12 px-2.5 py-1.5 font-medium text-link">
            Dashboard
          </div>
          <div className="rounded-md px-2.5 py-1.5 text-muted-foreground">
            Applications
          </div>
          <div className="rounded-md px-2.5 py-1.5 text-muted-foreground">
            Schedule
          </div>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-base font-semibold">Your application</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" tabIndex={-1} className="pointer-events-none">
              Submit application
            </Button>
            <Button
              type="button"
              variant="outline"
              tabIndex={-1}
              className="pointer-events-none"
            >
              Save draft
            </Button>
            <span className="text-sm text-link underline underline-offset-4">
              View schedule
            </span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-medium">
            <span className="rounded-md bg-brand-secondary px-2 py-1 text-brand-secondary-foreground">
              Secondary
            </span>
            <span
              className="rounded-md px-2 py-1"
              style={{
                backgroundColor: accent,
                color: readableOn(accent),
              }}
            >
              Accent
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BrandingCard() {
  const [settings, setSettings] = useState(null);
  const [effective, setEffective] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [uploadsEnabled, setUploadsEnabled] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

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

  const colorsChanged =
    form && settings
      ? COLOR_FIELDS.some(
          (f) => !sameColor(form[f.key], settings.branding?.[f.key]),
        )
      : false;

  async function persist() {
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
  }

  function onSubmit(e) {
    e.preventDefault();
    if (hasErrors) return;
    if (colorsChanged) {
      setConfirmOpen(true);
      return;
    }
    save();
  }

  // Name, logo and favicon changes apply without a restart.
  async function save() {
    setBusy(true);
    setError("");
    try {
      await persist();
      await refreshBranding();
      notifySuccess("Branding saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAndRestart() {
    setRestarting(true);
    setError("");
    try {
      await persist();
      await refreshBranding();
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setError(err.message);
      setRestarting(false);
      setConfirmOpen(false);
    }
  }

  async function upload(slot, file) {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      adopt(
        await apiUpload(`/api/admin/branding/${slot}`, body, {
          method: "PUT",
        }),
      );
      await refreshBranding();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(slot) {
    setBusy(true);
    setError("");
    try {
      adopt(
        await apiFetch(`/api/admin/branding/${slot}`, { method: "DELETE" }),
      );
      await refreshBranding();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const ready = form && settings && effective && defaults;

  // The colour shown for a field: what is typed if valid, else the default.
  function shownColor(key) {
    if (HEX.test(form[key].trim())) return form[key].trim();
    if (key === "accentColor") return shownColor("primaryColor");
    const fallback = {
      primaryColor: defaults.primaryColor,
      secondaryColor: defaults.secondaryColor || "#0f172a",
    }[key];
    return HEX.test(fallback || "") ? fallback : "#4f46e5";
  }

  return (
    <>
      <SettingsCard
        title="Branding"
        description="Name, colours and logos shown across the dashboard and in emails. Leave a field empty to use the server default."
        hint={
          colorsChanged
            ? "Changing colours restarts the dashboard."
            : "Name and logo changes apply right away."
        }
        error={error}
        onSubmit={onSubmit}
        action={
          <Button type="submit" loading={busy} disabled={!ready || hasErrors}>
            Save branding
          </Button>
        }
      >
        {!ready
          ? <CardLoading rows={4} />
          : <div className="space-y-6">
              <Field label="Name" htmlFor="brand-org-name">
                <Input
                  id="brand-org-name"
                  type="text"
                  maxLength={80}
                  value={form.orgName}
                  placeholder={defaults.orgName}
                  onChange={(e) => setField("orgName", e.target.value)}
                />
              </Field>

              <BrandPreview
                name={form.orgName.trim() || defaults.orgName}
                primary={shownColor("primaryColor")}
                secondary={shownColor("secondaryColor")}
                accent={shownColor("accentColor")}
                logo={imageSrc(effective.logoUrl)}
              />

              <div className="grid gap-5">
                {COLOR_FIELDS.map((field) => (
                  <ColorField
                    key={field.key}
                    field={field}
                    value={form[field.key]}
                    error={colorErrors[field.key]}
                    shown={shownColor(field.key)}
                    onChange={(v) => setField(field.key, v)}
                    onReset={() => setField(field.key, "")}
                  />
                ))}
              </div>

              <Separator />

              <div className="space-y-5">
                {IMAGE_SLOTS.map((item) => {
                  const current = effective[item.urlKey];
                  const hasUpload = Boolean(settings.branding?.[item.fileKey]);
                  return (
                    <div key={item.slot} className="grid gap-2">
                      <Label htmlFor={`brand-${item.slot}`}>{item.label}</Label>
                      <div className="flex flex-wrap items-center gap-3">
                        {current
                          ? // biome-ignore lint/performance/noImgElement: admin-configured logo, not a build-time asset
                            <img
                              src={imageSrc(current)}
                              alt={`Current ${item.label.toLowerCase()}`}
                              className="h-10 max-w-40 rounded-lg border border-border bg-background object-contain p-1"
                            />
                          : <span className="text-sm text-muted-foreground">
                              None set
                            </span>}
                        {/* The native file input stays for keyboard and
                            screen readers but is visually replaced by a button. */}
                        <input
                          id={`brand-${item.slot}`}
                          type="file"
                          accept={item.accept}
                          disabled={busy || !uploadsEnabled}
                          onChange={(e) => {
                            upload(item.slot, e.target.files?.[0]);
                            e.target.value = "";
                          }}
                          className="peer sr-only"
                        />
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:pointer-events-none peer-disabled:opacity-50"
                        >
                          <label htmlFor={`brand-${item.slot}`}>
                            Upload image
                          </label>
                        </Button>
                        {hasUpload || form[item.urlKey]
                          ? <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              onClick={() => remove(item.slot)}
                            >
                              Remove
                            </Button>
                          : null}
                      </div>
                      <Input
                        type="url"
                        aria-label={`${item.label} URL`}
                        value={form[item.urlKey]}
                        placeholder="Or paste an https:// image address"
                        onChange={(e) => setField(item.urlKey, e.target.value)}
                      />
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  {uploadsEnabled
                    ? "PNG, JPEG or WebP up to 1 MB. The favicon can also be an .ico file. SVG is not accepted."
                    : "Image storage is not set up on the server, so uploads are unavailable. Paste an https:// image address instead."}
                </p>
              </div>
            </div>}
      </SettingsCard>

      <AlertDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!restarting) setConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the dashboard?</AlertDialogTitle>
            <AlertDialogDescription>
              The dashboard will restart to apply the new colours.
              Everyone&apos;s open pages pick them up the next time they load.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restarting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restarting}
              onClick={(e) => {
                e.preventDefault();
                saveAndRestart();
              }}
            >
              {restarting
                ? <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Restarting…
                  </>
                : "Save and restart"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
