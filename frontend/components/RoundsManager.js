"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CardLoading,
  ErrorAlert,
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import WaitlistLimit from "@/components/WaitlistLimit";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";

function toLocalInput(value) {
  if (!value) return "";
  const d = new Date(value);
  // datetime-local wants "YYYY-MM-DDTHH:mm" in local time.
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
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
  text: "Short text",
  textarea: "Long text",
  number: "Number",
  select: "Dropdown",
  multiselect: "Checkboxes",
  checkbox: "Single checkbox",
  date: "Date",
  resume: "Resume (file upload)",
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
  ["university", "University or school"],
  ["major", "Major or field of study"],
  ["tshirtSize", "T-shirt size"],
  ["allergies", "Dietary restrictions and allergies"],
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

/**
 * Application rounds: create, open or close, set dates, waitlist limit and
 * the per-round application form.
 * @returns {JSX.Element}
 */
export default function RoundsManager() {
  const [rounds, setRounds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

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
    setAdding(true);
    try {
      await apiFetch("/api/admin/rounds", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      notifySuccess("Round added");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Application rounds"
        description="Run several cycles, for example early, regular and late, and set when each one opens and closes."
        error={error}
        onSubmit={createRound}
        hint="You can set dates and the form after adding."
        action={
          <Button type="submit" loading={adding}>
            <Plus aria-hidden="true" />
            Add round
          </Button>
        }
      >
        <Field label="New round name" htmlFor="new-round-name">
          <Input
            id="new-round-name"
            placeholder="Early applications"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
      </SettingsCard>

      {loading && rounds.length === 0
        ? <Card>
            <CardContent>
              <CardLoading rows={2} />
            </CardContent>
          </Card>
        : rounds.length === 0
          ? <p className="text-sm text-muted-foreground">No rounds yet.</p>
          : rounds.map((r) => (
              <RoundRow key={r._id} round={r} onChanged={load} />
            ))}
    </div>
  );
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
  const [savingWhat, setSavingWhat] = useState("");

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

  async function patch(body, what, message) {
    setSaving(true);
    setSavingWhat(what);
    setError("");
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (message) notifySuccess(message);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
      setSavingWhat("");
    }
  }

  async function saveDates() {
    await patch(
      {
        opensAt: opensAt ? new Date(opensAt).toISOString() : null,
        closesAt: closesAt ? new Date(closesAt).toISOString() : null,
      },
      "dates",
      "Dates saved",
    );
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
    await patch(
      {
        formConfig: payload,
        profileFields: profileToPayload(profile),
      },
      "form",
      "Application form saved",
    );
  }

  async function remove() {
    setSaving(true);
    setSavingWhat("delete");
    try {
      await apiFetch(`/api/admin/rounds/${round._id}`, { method: "DELETE" });
      notifySuccess("Round deleted");
      onChanged();
    } catch (err) {
      setError(err.message);
      setSaving(false);
      setSavingWhat("");
    }
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
          {round.name}
          <Badge variant={round.isOpen ? "success" : "outline"}>
            {round.isOpen ? "Open" : "Closed"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Applicants can apply while the round is open and inside its dates.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <SettingRow
          id={`open-${round._id}`}
          title="Open for applications"
          checked={round.isOpen}
          disabled={saving}
          onCheckedChange={() => patch({ isOpen: !round.isOpen }, "open", null)}
        />

        <Separator />

        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Opens" htmlFor={`opens-${round._id}`}>
            <Input
              id={`opens-${round._id}`}
              type="datetime-local"
              value={opensAt}
              onChange={(e) => setOpensAt(e.target.value)}
            />
          </Field>
          <Field label="Closes" htmlFor={`closes-${round._id}`}>
            <Input
              id={`closes-${round._id}`}
              type="datetime-local"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
          </Field>
          <Button
            type="button"
            variant="outline"
            loading={saving && savingWhat === "dates"}
            disabled={saving}
            onClick={saveDates}
          >
            Save dates
          </Button>
        </div>

        <Separator />

        <WaitlistLimit
          key={round.waitlistAfterAccepted ?? "none"}
          round={round}
          onChanged={onChanged}
        />

        {showForm
          ? <>
              <Separator />
              <ProfileFieldsEditor profile={profile} onChange={setProfile} />
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">Extra questions</p>
                  <p className="text-sm text-muted-foreground">
                    Applicants answer these for this round, after the built-in
                    questions.
                  </p>
                </div>
                {fields.length === 0
                  ? <p className="text-sm text-muted-foreground">
                      No extra questions yet.
                    </p>
                  : <div className="space-y-3">
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
                <Button type="button" variant="outline" onClick={addField}>
                  <Plus aria-hidden="true" />
                  Add question
                </Button>
              </div>
            </>
          : null}

        <ErrorAlert message={error} />
      </CardContent>

      <CardFooter className="flex-wrap justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            aria-expanded={showForm}
            onClick={() => setShowForm((s) => !s)}
          >
            {showForm ? "Hide application form" : "Edit application form"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive" disabled={saving}>
                <Trash2 aria-hidden="true" />
                Delete round
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {round.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The round and its form settings are removed. This cannot be
                  undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={remove}>
                  Delete round
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {showForm
          ? <Button
              type="button"
              loading={saving && savingWhat === "form"}
              disabled={saving}
              onClick={saveForm}
            >
              Save application form
            </Button>
          : null}
      </CardFooter>
    </Card>
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
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Built-in questions</p>
        <p className="text-sm text-muted-foreground">
          Name (and email, without an account) are always required. Tick the
          others this round requires.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {PROFILE_FIELDS.map(([key, label]) => (
          <div key={key} className="flex items-center gap-2">
            <Checkbox
              id={`profile-${key}`}
              checked={profile.required.includes(key)}
              onCheckedChange={(v) => toggle(key, v === true)}
            />
            <Label htmlFor={`profile-${key}`} className="font-normal">
              {label}
            </Label>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Education level choices" htmlFor="profile-education">
          <Textarea
            id="profile-education"
            rows={4}
            value={profile.education}
            onChange={(e) =>
              onChange({ ...profile, education: e.target.value })
            }
            placeholder="One per line. Leave empty for the standard choices."
          />
        </Field>
        <Field label="Gender choices" htmlFor="profile-gender">
          <Textarea
            id="profile-gender"
            rows={4}
            value={profile.gender}
            onChange={(e) => onChange({ ...profile, gender: e.target.value })}
            placeholder="One per line. Leave empty for the standard choices."
          />
        </Field>
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

  const id = `field-${field._uid}`;

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_2fr_1fr]">
        <Field label="Key" htmlFor={`${id}-key`}>
          <Input
            id={`${id}-key`}
            value={field.key}
            onChange={(e) => onChange({ key: e.target.value })}
            placeholder="dietary"
          />
        </Field>
        <Field label="Label" htmlFor={`${id}-label`}>
          <Input
            id={`${id}-label`}
            value={field.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder="Dietary restrictions"
          />
        </Field>
        <Field label="Type" htmlFor={`${id}-type`}>
          <Select
            value={field.type}
            onValueChange={(type) => onChange({ type })}
          >
            <SelectTrigger id={`${id}-type`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {FIELD_TYPE_LABELS[t] || t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        Labels can contain links: [text](https://example.com)
      </p>

      {HAS_OPTIONS.includes(field.type)
        ? <Field label="Options, one per line" htmlFor={`${id}-options`}>
            <Textarea
              id={`${id}-options`}
              rows={Math.max(3, (field.options || []).length + 1)}
              value={optionsText}
              onChange={(e) => setOptionsFromText(e.target.value)}
              placeholder={"none\nvegetarian\nvegan"}
            />
          </Field>
        : null}

      <Field label="Help text (optional)" htmlFor={`${id}-help`}>
        <Textarea
          id={`${id}-help`}
          rows={2}
          value={field.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Shown under the question. Links: [link text](https://example.com)"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-required`}
            checked={field.required}
            onCheckedChange={(v) => onChange({ required: v === true })}
          />
          <Label htmlFor={`${id}-required`} className="font-normal">
            Required
          </Label>
        </div>
        {HAS_OPTIONS.includes(field.type)
          ? <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-other`}
                checked={field.allowOther}
                onCheckedChange={(v) => onChange({ allowOther: v === true })}
              />
              <Label htmlFor={`${id}-other`} className="font-normal">
                Allow &quot;Other&quot; with a text box
              </Label>
            </div>
          : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isFirst}
          onClick={onMoveUp}
        >
          <ArrowUp aria-hidden="true" />
          Move up
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isLast}
          onClick={onMoveDown}
        >
          <ArrowDown aria-hidden="true" />
          Move down
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
