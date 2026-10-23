"use client";

import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CardLoading, Field, SettingsCard } from "@/components/SettingsParts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";

const TEMPLATE_LABELS = {
  application_received: "Application received",
  application_accepted: "Application accepted",
  application_rejected: "Application rejected",
  application_waitlisted: "Application waitlisted",
  account_setup: "Account setup (applied without an account)",
  verify_email: "Email verification (sign-up)",
  checked_in: "Checked in",
};

const PLACEHOLDER_GUIDE = [
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

const QRCODE_TOKEN = /\{\{\s*qrcode\s*\}\}/;

/**
 * Edit the transactional email templates, with a server-rendered preview.
 * @returns {JSX.Element}
 */
export default function EmailTemplateEditor() {
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
    try {
      const data = await apiFetch("/api/admin/email-templates/test", {
        method: "POST",
        body: JSON.stringify({ subject, body }),
      });
      notifySuccess(`Test email sent to ${data.sentTo}`);
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
      notifySuccess("Template saved");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const missingQr =
    activeTemplate?.key === "application_accepted" && !QRCODE_TOKEN.test(body);

  return (
    <SettingsCard
      title="Email templates"
      description="Emails sent when someone applies, is accepted, rejected or waitlisted, and when they check in. The preview is the real email, with your own QR code."
      error={error}
      action={
        activeTemplate
          ? <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={loadTemplates}
                disabled={saving}
              >
                Discard changes
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={sendTest}
                loading={testing}
              >
                Send test to me
              </Button>
              <Button type="button" onClick={saveTemplate} loading={saving}>
                Save template
              </Button>
            </div>
          : null
      }
    >
      {loading
        ? <CardLoading rows={4} />
        : !activeTemplate
          ? <p className="text-sm text-muted-foreground">No templates found.</p>
          : <div className="space-y-5">
              <Field label="Template" htmlFor="template-select">
                <Select value={selectedKey} onValueChange={setSelectedKey}>
                  <SelectTrigger
                    id="template-select"
                    className="w-full sm:w-80"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((template) => (
                      <SelectItem key={template._id} value={template.key}>
                        {TEMPLATE_LABELS[template.key] || template.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Subject" htmlFor="template-subject">
                <Input
                  id="template-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>

              <Field label="Body" htmlFor="template-body">
                <Textarea
                  id="template-body"
                  ref={bodyRef}
                  className="min-h-36 font-mono"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
              </Field>

              {missingQr
                ? <Alert variant="warning">
                    <TriangleAlert aria-hidden="true" />
                    <AlertDescription className="text-warning">
                      This acceptance email has no {"{{qrcode}}"}, so accepted
                      applicants will not get their check-in QR code.{" "}
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0"
                        onClick={() => insertToken("{{qrcode}}")}
                      >
                        Insert it
                      </Button>
                    </AlertDescription>
                  </Alert>
                : null}

              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm font-medium">Placeholders</p>
                <p className="text-sm text-muted-foreground">
                  Click one to insert it at the cursor in the body.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {PLACEHOLDER_GUIDE.map((token) => (
                    <Button
                      type="button"
                      key={token}
                      variant="outline"
                      size="xs"
                      className="font-mono"
                      onClick={() => insertToken(token)}
                    >
                      {token}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {"{{qrcode}}"} puts the recipient&apos;s check-in QR code
                  (SHA-256 of their email) where you place it, in any template.
                  Templates without it have no QR code. {"{{runOfShow}}"} lists
                  the schedule (checked-in email). {"{{websiteUrl}}"} and{" "}
                  {"{{discordUrl}}"} come from the server settings
                  ORG_WEBSITE_URL and ORG_DISCORD_URL.
                </p>
              </div>

              <div className="space-y-2 rounded-lg border border-border p-3">
                <p className="text-sm font-medium">Preview</p>
                {previewError
                  ? <p className="text-sm text-muted-foreground">
                      Preview unavailable: {previewError}
                    </p>
                  : !preview
                    ? <p className="text-sm text-muted-foreground">
                        Rendering…
                      </p>
                    : <>
                        <p className="text-sm">
                          <span className="font-medium">Subject:</span>{" "}
                          {preview.subject}
                        </p>
                        {/* Sandboxed: the HTML is escaped server-side, and the
                            iframe keeps any email styling off this page. */}
                        <iframe
                          title="Email preview"
                          sandbox=""
                          srcDoc={`<!doctype html><html><body style="margin:0;padding:12px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#171821;background:#fff">${preview.html}</body></html>`}
                          className={`w-full rounded-md border border-border bg-white ${
                            preview.hasQrCode ? "h-[460px]" : "h-60"
                          }`}
                        />
                      </>}
              </div>
            </div>}
    </SettingsCard>
  );
}
