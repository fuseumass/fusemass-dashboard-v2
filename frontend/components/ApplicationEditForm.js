"use client";

// Staff correction of a submitted application, shown in the review drawer's
// edit mode: every built-in field, every custom answer (with the same
// controls the application form uses) and the account's name and email.
// Saves through PATCH /api/admin/applications/:id/details, sending only what
// changed, so a question the applicant skipped doesn't block fixing a typo.
import { Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import {
  CheckRow,
  ChoiceSelect,
  DynamicField,
  EDUCATION_LEVELS,
  Field,
  GENDERS,
  TSHIRT_SIZES,
} from "@/components/ApplicationForm";
import Autocomplete from "@/components/Autocomplete";
import TagAutocomplete from "@/components/TagAutocomplete";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { apiFetch } from "@/lib/api";

const TEXT_FIELDS = [
  ["phone", "Phone", "tel"],
  ["pronouns", "Pronouns", "text"],
];

function initialValues(app) {
  return {
    user: {
      name: app.applicant?.name || "",
      email: app.applicant?.email || "",
    },
    fields: {
      name: app.name || "",
      phone: app.phone || "",
      age: app.age ?? "",
      gender: app.gender || "",
      pronouns: app.pronouns || "",
      education: app.education || "",
      university: app.university || "",
      major: app.major || "",
      allergies: app.allergies || "",
      tshirtSize: app.tshirtSize || "",
      socials: {
        linkedin: app.socials?.linkedin || "",
        github: app.socials?.github || "",
        website: app.socials?.website || "",
        other: (app.socials?.other || []).map((link) => ({
          label: link.label || "",
          url: link.url || "",
        })),
      },
      experience: {
        attendedBefore: Boolean(app.experience?.attendedBefore),
        hackathonsAttended: app.experience?.hackathonsAttended || 0,
        attendedThisBefore: Boolean(app.experience?.attendedThisBefore),
      },
      programmingSkills: app.programmingSkills || [],
      hardwareSkills: app.hardwareSkills || [],
      otherSkills: app.otherSkills || [],
    },
    answers: { ...(app.answers || {}) },
  };
}

// The keys of `next` whose value differs from `before`.
function changedPart(before, next) {
  const out = {};
  for (const key of Object.keys(next)) {
    if (JSON.stringify(before[key] ?? "") !== JSON.stringify(next[key] ?? "")) {
      out[key] = next[key];
    }
  }
  return out;
}

/**
 * The edit form for one application.
 * @param {object} props - `{ app, onSaved(response), onCancel }`; `app` is
 *   the full application from GET /api/admin/applications/:id.
 * @returns {JSX.Element}
 */
export default function ApplicationEditForm({ app, onSaved, onCancel }) {
  const uid = useId();
  const [initial] = useState(() => initialValues(app));
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const round = app.round || {};
  const profileFields = round.profileFields || {};
  const isRequired = (key) => (profileFields.required || []).includes(key);
  const questions = (round.formConfig || []).filter(
    (field) => field?.key && field.type !== "resume",
  );
  const idOf = (key) => `${uid}-${key}`;

  function clearError(key) {
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  function setPart(part, key, value) {
    setValues((v) => ({ ...v, [part]: { ...v[part], [key]: value } }));
    clearError(`${part}.${key}`);
  }
  function setNested(key, sub, value) {
    setValues((v) => ({
      ...v,
      fields: { ...v.fields, [key]: { ...v.fields[key], [sub]: value } },
    }));
    clearError(`fields.${key}`);
  }
  function setOtherLink(index, prop, value) {
    const other = values.fields.socials.other.map((link, i) =>
      i === index ? { ...link, [prop]: value } : link,
    );
    setNested("socials", "other", other);
  }

  const fieldProps = (key, label, required) => ({
    id: idOf(key),
    label,
    required: required ?? isRequired(key),
    error: errors[`fields.${key}`],
  });

  async function save(event) {
    event.preventDefault();
    setError("");
    const body = {};
    const fields = changedPart(initial.fields, values.fields);
    const answers = changedPart(initial.answers, values.answers);
    const user = changedPart(initial.user, values.user);
    if (Object.keys(fields).length) body.fields = fields;
    if (Object.keys(answers).length) body.answers = answers;
    if (Object.keys(user).length) body.user = user;
    if (!Object.keys(body).length) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      const data = await apiFetch(
        `/api/admin/applications/${app._id}/details`,
        { method: "PATCH", body: JSON.stringify(body) },
      );
      onSaved(data);
    } catch (err) {
      const named = err.data?.errors;
      if (named && Object.keys(named).length) {
        setErrors(named);
        setError("Fix the highlighted fields and save again.");
      } else {
        setError(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  const f = values.fields;
  const genderOptions = withCurrent(
    profileFields.options?.gender || GENDERS,
    f.gender,
  );
  const educationOptions = withCurrent(
    profileFields.options?.education || EDUCATION_LEVELS,
    f.education,
  );

  return (
    <form onSubmit={save} noValidate className="space-y-6">
      <EditSection title="Account">
        <Field
          id={idOf("user-email")}
          label="Account email"
          required
          description="Where decision and check-in emails go."
          error={errors["user.email"]}
        >
          <Input
            id={idOf("user-email")}
            type="email"
            autoComplete="off"
            value={values.user.email}
            aria-invalid={Boolean(errors["user.email"]) || undefined}
            onChange={(e) => setPart("user", "email", e.target.value)}
          />
        </Field>
        <Field
          id={idOf("user-name")}
          label="Account name"
          required
          error={errors["user.name"]}
        >
          <Input
            id={idOf("user-name")}
            value={values.user.name}
            aria-invalid={Boolean(errors["user.name"]) || undefined}
            onChange={(e) => setPart("user", "name", e.target.value)}
          />
        </Field>
      </EditSection>

      <Separator />

      <EditSection title="Personal">
        <Field {...fieldProps("name", "Full name on application", true)}>
          <Input
            id={idOf("name")}
            value={f.name}
            aria-invalid={Boolean(errors["fields.name"]) || undefined}
            onChange={(e) => setPart("fields", "name", e.target.value)}
          />
        </Field>
        <Field {...fieldProps("age", "Age")}>
          <Input
            id={idOf("age")}
            type="number"
            min="0"
            inputMode="numeric"
            value={f.age}
            aria-invalid={Boolean(errors["fields.age"]) || undefined}
            onChange={(e) => setPart("fields", "age", e.target.value)}
          />
        </Field>
        <Field {...fieldProps("gender", "Gender")}>
          <ChoiceSelect
            id={idOf("gender")}
            value={f.gender}
            options={genderOptions}
            required={isRequired("gender")}
            invalid={Boolean(errors["fields.gender"])}
            onChange={(v) => setPart("fields", "gender", v)}
          />
        </Field>
        {TEXT_FIELDS.map(([key, label, type]) => (
          <Field key={key} {...fieldProps(key, label)}>
            <Input
              id={idOf(key)}
              type={type}
              value={f[key]}
              aria-invalid={Boolean(errors[`fields.${key}`]) || undefined}
              onChange={(e) => setPart("fields", key, e.target.value)}
            />
          </Field>
        ))}
      </EditSection>

      <Separator />

      <EditSection title="Education">
        <Field {...fieldProps("education", "Education level")}>
          <ChoiceSelect
            id={idOf("education")}
            value={f.education}
            options={educationOptions}
            required={isRequired("education")}
            invalid={Boolean(errors["fields.education"])}
            onChange={(v) => setPart("fields", "education", v)}
          />
        </Field>
        <Field {...fieldProps("university", "University or school")}>
          <Autocomplete
            id={idOf("university")}
            value={f.university}
            invalid={Boolean(errors["fields.university"])}
            onChange={(v) => setPart("fields", "university", v)}
            endpoint="/api/meta/colleges"
            placeholder="Start typing"
          />
        </Field>
        <Field {...fieldProps("major", "Major or field of study")}>
          <Input
            id={idOf("major")}
            value={f.major}
            aria-invalid={Boolean(errors["fields.major"]) || undefined}
            onChange={(e) => setPart("fields", "major", e.target.value)}
          />
        </Field>
      </EditSection>

      <Separator />

      <EditSection title="Logistics">
        <Field {...fieldProps("tshirtSize", "T-shirt size")}>
          <ChoiceSelect
            id={idOf("tshirtSize")}
            value={f.tshirtSize}
            options={TSHIRT_SIZES}
            required={isRequired("tshirtSize")}
            invalid={Boolean(errors["fields.tshirtSize"])}
            onChange={(v) => setPart("fields", "tshirtSize", v)}
          />
        </Field>
        <Field
          {...fieldProps("allergies", "Dietary restrictions or allergies")}
        >
          <Input
            id={idOf("allergies")}
            value={f.allergies}
            aria-invalid={Boolean(errors["fields.allergies"]) || undefined}
            onChange={(e) => setPart("fields", "allergies", e.target.value)}
          />
        </Field>
      </EditSection>

      <Separator />

      <EditSection title="Links">
        {[
          ["linkedin", "LinkedIn"],
          ["github", "GitHub"],
          ["website", "Personal website"],
        ].map(([key, label]) => (
          <Field
            key={key}
            id={idOf(key)}
            label={label}
            error={key === "linkedin" ? errors["fields.socials"] : undefined}
          >
            <Input
              id={idOf(key)}
              type="url"
              value={f.socials[key]}
              onChange={(e) => setNested("socials", key, e.target.value)}
            />
          </Field>
        ))}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Other links</legend>
          {f.socials.other.map((link, index) => (
            // Links have no id of their own; the position is the identity.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={`Link ${index + 1} label`}
                placeholder="Label"
                className="w-28 shrink-0"
                value={link.label}
                onChange={(e) => setOtherLink(index, "label", e.target.value)}
              />
              <Input
                aria-label={`Link ${index + 1} URL`}
                type="url"
                placeholder="https://"
                value={link.url}
                onChange={(e) => setOtherLink(index, "url", e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove link ${index + 1}`}
                onClick={() =>
                  setNested(
                    "socials",
                    "other",
                    f.socials.other.filter((_, i) => i !== index),
                  )
                }
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setNested("socials", "other", [
                ...f.socials.other,
                { label: "", url: "" },
              ])
            }
          >
            <Plus aria-hidden="true" />
            Add link
          </Button>
        </fieldset>
      </EditSection>

      <Separator />

      <EditSection title="Hackathon experience">
        <CheckRow
          id={idOf("attendedBefore")}
          checked={f.experience.attendedBefore}
          onChange={(v) => setNested("experience", "attendedBefore", v)}
        >
          Has attended a hackathon before
        </CheckRow>
        <Field
          id={idOf("hackathonsAttended")}
          label="Hackathons attended"
          error={errors["fields.experience"]}
        >
          <Input
            id={idOf("hackathonsAttended")}
            type="number"
            min="0"
            inputMode="numeric"
            className="w-32"
            value={f.experience.hackathonsAttended}
            onChange={(e) =>
              setNested(
                "experience",
                "hackathonsAttended",
                e.target.value === "" ? 0 : Number(e.target.value),
              )
            }
          />
        </Field>
        <CheckRow
          id={idOf("attendedThisBefore")}
          checked={f.experience.attendedThisBefore}
          onChange={(v) => setNested("experience", "attendedThisBefore", v)}
        >
          Has attended this event before
        </CheckRow>
      </EditSection>

      <Separator />

      <EditSection title="Skills">
        <Field {...fieldProps("programmingSkills", "Programming skills")}>
          <TagAutocomplete
            id={idOf("programmingSkills")}
            values={f.programmingSkills}
            onChange={(v) => setPart("fields", "programmingSkills", v)}
            endpoint="/api/meta/skills/programming"
            placeholder="Search skills, or type one and press Enter"
          />
        </Field>
        <Field {...fieldProps("hardwareSkills", "Hardware skills")}>
          <TagAutocomplete
            id={idOf("hardwareSkills")}
            values={f.hardwareSkills}
            onChange={(v) => setPart("fields", "hardwareSkills", v)}
            endpoint="/api/meta/skills/hardware"
            placeholder="Search skills, or type one and press Enter"
          />
        </Field>
        <Field
          {...fieldProps("otherSkills", "Other skills", false)}
          description="Separate skills with commas."
        >
          <Input
            id={idOf("otherSkills")}
            defaultValue={f.otherSkills.join(", ")}
            onChange={(e) =>
              setPart(
                "fields",
                "otherSkills",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
      </EditSection>

      {questions.length
        ? <>
            <Separator />
            <EditSection title="Additional questions">
              {questions.map((field) => (
                <DynamicField
                  key={field.key}
                  id={idOf(`q_${field.key}`)}
                  // Staff can't consent for an applicant, so a required
                  // checkbox isn't required here (the server agrees).
                  field={
                    field.type === "checkbox"
                      ? { ...field, required: false }
                      : field
                  }
                  error={errors[`answers.${field.key}`]}
                  value={values.answers[field.key]}
                  onChange={(v) => setPart("answers", field.key, v)}
                />
              ))}
            </EditSection>
          </>
        : null}

      <div className="sticky -bottom-4 -mx-4 -mb-4 space-y-3 border-t bg-popover px-4 py-3">
        {error
          ? <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Save changes
          </Button>
        </div>
      </div>
    </form>
  );
}

// Keep a stored answer selectable even when the round's choices changed.
function withCurrent(options, current) {
  return current && !options.includes(current)
    ? [...options, current]
    : options;
}

function EditSection({ title, children }) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}
