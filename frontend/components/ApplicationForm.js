"use client";

// The application form, in two modes:
//   - "account": a logged-in applicant's own application (drafts, edits,
//     status), at /dashboard/application.
//   - "public": applying without an account (admin setting), on the home
//     page. Adds an email field, has no drafts, and can't edit afterwards.
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import Autocomplete from "@/components/Autocomplete";
import FileDropzone from "@/components/FileDropzone";
import RichText, { plainText } from "@/components/RichText";
import SignedLinkButton from "@/components/SignedLinkButton";
import { FormSkeleton } from "@/components/skeletons";
import TagAutocomplete from "@/components/TagAutocomplete";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { apiFetch, apiUpload } from "@/lib/api";
import { config } from "@/lib/config";
import { cn } from "@/lib/utils";

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

// Sentinel for "no answer" in a Select, since Radix items can't be "".
const NONE = "__none__";

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

/**
 * The application form, in "account" or "public" mode (see top of file).
 * @param {object} props - `{ mode: "account" | "public" }`.
 * @returns {JSX.Element}
 */
export default function ApplicationForm({ mode = "account" }) {
  const isPublic = mode === "public";
  const uid = useId();
  const [form, setForm] = useState(emptyForm());
  const [resumeFile, setResumeFile] = useState(null);
  const [round, setRound] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [submittedStatus, setSubmittedStatus] = useState(null);
  // Public mode: the address a finished submission was sent from, and whether
  // that address already has an account (then they should log in instead).
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [accountExists, setAccountExists] = useState(false);

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

  // Editing a field clears its error.
  function clearFieldError(key) {
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
    clearFieldError(key);
  }
  function setSocial(key, value) {
    setForm((f) => ({ ...f, socials: { ...f.socials, [key]: value } }));
  }
  function setExperience(key, value) {
    setForm((f) => ({ ...f, experience: { ...f.experience, [key]: value } }));
  }
  function setAnswer(key, value) {
    setForm((f) => ({ ...f, answers: { ...f.answers, [key]: value } }));
    clearFieldError(`q_${key}`);
  }
  function setResume(file) {
    setResumeFile(file);
    for (const key of Object.keys(fieldErrors)) {
      if (key.startsWith("q_")) clearFieldError(key);
    }
  }

  // Required-field checks for a final submit. Returns { fieldKey: message }.
  function validate() {
    const errors = {};
    const required = round?.profileFields?.required || [];
    const text = (v) => String(v ?? "").trim();
    if (isPublic) {
      if (!text(form.email)) {
        errors.email = "Enter your email address.";
      } else if (!text(form.email).includes("@")) {
        errors.email = "Enter a valid email address.";
      }
    }
    if (!text(form.name)) {
      errors.name = "Enter your full name.";
    }
    for (const key of required) {
      if (key === "programmingSkills" || key === "hardwareSkills") {
        if (form[key].length === 0) errors[key] = "Add at least one skill.";
      } else if (key in form && !text(form[key])) {
        errors[key] = "This field is required.";
      }
    }
    for (const field of round?.formConfig || []) {
      if (!field.required) continue;
      const answer = form.answers[field.key];
      let missing = false;
      if (field.type === "resume") {
        missing = !resumeFile && (isPublic || !form.hasResume);
      } else if (field.type === "checkbox") {
        missing = !answer;
      } else if (field.type === "multiselect") {
        missing = !Array.isArray(answer) || answer.length === 0;
      } else {
        missing = !text(answer);
      }
      if (missing) {
        errors[`q_${field.key}`] =
          field.type === "checkbox"
            ? "Tick this box to continue."
            : "This field is required.";
      }
    }
    return errors;
  }

  async function submit(status) {
    setError("");
    setSuccess("");
    setAccountExists(false);

    if (status === "pending") {
      const errors = validate();
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) {
        setError("Fix the highlighted fields and submit again.");
        requestAnimationFrame(() => {
          const first = document.querySelector('[aria-invalid="true"]');
          if (first) {
            first.scrollIntoView({ block: "center", behavior: "smooth" });
            first.focus({ preventScroll: true });
          }
        });
        return;
      }
    } else {
      setFieldErrors({});
    }

    setSubmitting(true);
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

      if (resumeFile) {
        fd.append("resume", resumeFile);
      }

      if (isPublic) {
        await apiUpload("/api/applications/public", fd);
        setSubmittedEmail(form.email.trim());
        window.scrollTo(0, 0);
        return;
      }

      const data = await apiUpload("/api/applications", fd);
      setSubmittedStatus(data.application.status);
      setForm((f) => ({
        ...f,
        hasResume: Boolean(data.application.hasResume),
      }));
      setResumeFile(null);
      setSuccess(
        status === "draft"
          ? "Draft saved. You can come back and finish later."
          : "Application submitted. We will email you when there is a decision.",
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
    return <FormSkeleton fields={6} />;
  }

  if (isPublic && submittedEmail) {
    return (
      <Alert variant="success" className="p-4">
        <CircleCheck aria-hidden="true" />
        <AlertTitle className="text-base">Application received</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>
            Thanks for applying to {config.orgName}. We sent a confirmation to{" "}
            <span className="font-medium">{submittedEmail}</span>.
          </p>
          <p>
            If you are accepted, we will email you a link to set up your
            account. Your status and check-in QR code will be there.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  if (!round) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Application</h1>
        {error
          ? <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : <Alert>
              <AlertDescription>
                Applications are not open right now. Check back later.
              </AlertDescription>
            </Alert>}
      </div>
    );
  }

  // A resume question in the round's custom form replaces the built-in one.
  const resumeQuestion = (round.formConfig || []).find(
    (f) => f.type === "resume",
  );
  // The round's settings for built-in questions: which are required, and
  // replacement choices for the education and gender selects.
  const profileFields = round.profileFields || {};
  const isRequired = (key) => (profileFields.required || []).includes(key);
  const genderOptions = profileFields.options?.gender || GENDERS;
  const educationOptions = profileFields.options?.education || EDUCATION_LEVELS;
  const idOf = (key) => `${uid}-${key}`;
  // Props every built-in field shares: id, label wiring and its error.
  const fieldProps = (key, label) => ({
    id: idOf(key),
    label,
    required: key === "name" || key === "email" || isRequired(key),
    error: fieldErrors[key],
  });
  const invalid = (key) => Boolean(fieldErrors[key]) || undefined;

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="mx-auto w-full max-w-3xl"
    >
      <header className="space-y-2 pb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {isPublic ? `Apply to ${config.orgName}` : "Application"}
        </h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{round.name}</span>
          {submittedStatus
            ? <ApplicationStatusBadge status={submittedStatus} />
            : null}
        </div>
        {round.description
          ? <p className="text-sm whitespace-pre-wrap">
              <RichText text={round.description} />
            </p>
          : null}
        {isPublic
          ? <p className="text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-medium text-link hover:underline"
              >
                Log in
              </Link>
            </p>
          : null}
      </header>

      <div className="space-y-8">
        <Section title="Personal">
          {isPublic
            ? <Field {...fieldProps("email", "Email")}>
                <Input
                  id={idOf("email")}
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  aria-invalid={invalid("email")}
                  onChange={(e) => setField("email", e.target.value)}
                />
              </Field>
            : null}
          <Field {...fieldProps("name", "Full name")}>
            <Input
              id={idOf("name")}
              autoComplete="name"
              value={form.name}
              aria-invalid={invalid("name")}
              onChange={(e) => setField("name", e.target.value)}
            />
          </Field>
          <Field {...fieldProps("phone", "Phone")}>
            <Input
              id={idOf("phone")}
              type="tel"
              autoComplete="tel"
              value={form.phone}
              aria-invalid={invalid("phone")}
              onChange={(e) => setField("phone", e.target.value)}
            />
          </Field>
          <Field {...fieldProps("age", "Age")}>
            <Input
              id={idOf("age")}
              type="number"
              min="0"
              inputMode="numeric"
              value={form.age}
              aria-invalid={invalid("age")}
              onChange={(e) => setField("age", e.target.value)}
            />
          </Field>
          <Field {...fieldProps("gender", "Gender")}>
            <ChoiceSelect
              id={idOf("gender")}
              value={form.gender}
              options={genderOptions}
              required={isRequired("gender")}
              invalid={Boolean(fieldErrors.gender)}
              onChange={(v) => setField("gender", v)}
            />
          </Field>
          <Field {...fieldProps("pronouns", "Pronouns")}>
            <Input
              id={idOf("pronouns")}
              value={form.pronouns}
              placeholder="e.g. she/her"
              aria-invalid={invalid("pronouns")}
              onChange={(e) => setField("pronouns", e.target.value)}
            />
          </Field>
        </Section>

        <Separator />

        <Section title="Education">
          <Field {...fieldProps("education", "Education level")}>
            <ChoiceSelect
              id={idOf("education")}
              value={form.education}
              options={educationOptions}
              required={isRequired("education")}
              invalid={Boolean(fieldErrors.education)}
              onChange={(v) => setField("education", v)}
            />
          </Field>
          <Field {...fieldProps("university", "University or school")}>
            <Autocomplete
              id={idOf("university")}
              value={form.university}
              invalid={Boolean(fieldErrors.university)}
              onChange={(v) => setField("university", v)}
              endpoint="/api/meta/colleges"
              placeholder="Start typing"
            />
          </Field>
          <Field {...fieldProps("major", "Major or field of study")}>
            <Input
              id={idOf("major")}
              value={form.major}
              aria-invalid={invalid("major")}
              onChange={(e) => setField("major", e.target.value)}
            />
          </Field>
        </Section>

        <Separator />

        <Section title="Logistics">
          <Field {...fieldProps("tshirtSize", "T-shirt size")}>
            <ChoiceSelect
              id={idOf("tshirtSize")}
              value={form.tshirtSize}
              options={TSHIRT_SIZES}
              required={isRequired("tshirtSize")}
              invalid={Boolean(fieldErrors.tshirtSize)}
              onChange={(v) => setField("tshirtSize", v)}
            />
          </Field>
          <Field
            {...fieldProps("allergies", "Dietary restrictions or allergies")}
          >
            <Input
              id={idOf("allergies")}
              value={form.allergies}
              placeholder="e.g. peanuts, vegetarian"
              aria-invalid={invalid("allergies")}
              onChange={(e) => setField("allergies", e.target.value)}
            />
          </Field>
          {resumeQuestion
            ? null
            : <Field id={idOf("resume")} label="Resume" wide>
                <ResumeInput
                  id={idOf("resume")}
                  file={resumeFile}
                  onChange={setResume}
                  hasResume={!isPublic && form.hasResume}
                />
              </Field>}
        </Section>

        <Separator />

        <Section title="Links">
          <Field id={idOf("linkedin")} label="LinkedIn">
            <Input
              id={idOf("linkedin")}
              value={form.socials.linkedin}
              onChange={(e) => setSocial("linkedin", e.target.value)}
              placeholder="https://linkedin.com/in/..."
            />
          </Field>
          <Field id={idOf("github")} label="GitHub">
            <Input
              id={idOf("github")}
              value={form.socials.github}
              onChange={(e) => setSocial("github", e.target.value)}
              placeholder="https://github.com/..."
            />
          </Field>
          <Field id={idOf("website")} label="Personal website">
            <Input
              id={idOf("website")}
              value={form.socials.website}
              onChange={(e) => setSocial("website", e.target.value)}
              placeholder="https://..."
            />
          </Field>
        </Section>

        <Separator />

        <Section title="Hackathon experience" single>
          <CheckRow
            id={idOf("attendedBefore")}
            checked={form.experience.attendedBefore}
            onChange={(v) => setExperience("attendedBefore", v)}
          >
            I have attended a hackathon before
          </CheckRow>
          {form.experience.attendedBefore
            ? <Field
                id={idOf("hackathonsAttended")}
                label="How many hackathons have you attended?"
              >
                <Input
                  id={idOf("hackathonsAttended")}
                  type="number"
                  min="0"
                  inputMode="numeric"
                  className="w-32"
                  value={form.experience.hackathonsAttended}
                  onChange={(e) =>
                    setExperience("hackathonsAttended", Number(e.target.value))
                  }
                />
              </Field>
            : null}
          <CheckRow
            id={idOf("attendedThisBefore")}
            checked={form.experience.attendedThisBefore}
            onChange={(v) => setExperience("attendedThisBefore", v)}
          >
            I have attended {config.orgName} before
          </CheckRow>
        </Section>

        {round.formConfig && round.formConfig.length > 0
          ? <>
              <Separator />
              <Section title="Additional questions">
                {round.formConfig.map((field) => (
                  <div
                    key={field.key}
                    // Long questions and checkbox lists take the full width.
                    className={isWide(field) ? "sm:col-span-2" : undefined}
                  >
                    {field.type === "resume"
                      ? <Field
                          id={idOf(`q_${field.key}`)}
                          label={field.label}
                          required={field.required}
                          description={field.description}
                          error={fieldErrors[`q_${field.key}`]}
                        >
                          <ResumeInput
                            id={idOf(`q_${field.key}`)}
                            file={resumeFile}
                            onChange={setResume}
                            hasResume={!isPublic && form.hasResume}
                            invalid={Boolean(fieldErrors[`q_${field.key}`])}
                          />
                        </Field>
                      : <DynamicField
                          id={idOf(`q_${field.key}`)}
                          field={field}
                          error={fieldErrors[`q_${field.key}`]}
                          value={form.answers[field.key]}
                          onChange={(v) => setAnswer(field.key, v)}
                        />}
                  </div>
                ))}
              </Section>
            </>
          : null}

        <Separator />

        <Section title="Skills" single>
          <Field {...fieldProps("programmingSkills", "Programming skills")}>
            <TagAutocomplete
              id={idOf("programmingSkills")}
              values={form.programmingSkills}
              onChange={(v) => setField("programmingSkills", v)}
              endpoint="/api/meta/skills/programming"
              placeholder="Search skills, or type your own and press Enter"
            />
          </Field>
          <Field {...fieldProps("hardwareSkills", "Hardware skills")}>
            <TagAutocomplete
              id={idOf("hardwareSkills")}
              values={form.hardwareSkills}
              onChange={(v) => setField("hardwareSkills", v)}
              endpoint="/api/meta/skills/hardware"
              placeholder="Search skills, or type your own and press Enter"
            />
          </Field>
        </Section>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 mt-8 space-y-3 border-t bg-background px-4 py-3 md:mx-0 md:px-0">
        {error
          ? <Alert variant="destructive">
              <AlertDescription>
                {error}
                {accountExists
                  ? <>
                      {" "}
                      <Link
                        href="/login"
                        className="font-medium underline underline-offset-4"
                      >
                        Log in
                      </Link>
                    </>
                  : null}
              </AlertDescription>
            </Alert>
          : null}
        {success
          ? <Alert variant="success" aria-live="polite">
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          : null}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isPublic
            ? null
            : <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => submit("draft")}
              >
                Save draft
              </Button>}
          <Button type="submit" loading={submitting}>
            {submitting ? "Submitting" : "Submit application"}
          </Button>
        </div>
      </div>
    </form>
  );
}

// The resume picker, plus a link to the one already uploaded (logged-in
// applicants only: viewing goes through their authenticated resume endpoint).
function ResumeInput({ id, file, onChange, hasResume, invalid }) {
  return (
    <div className="space-y-2">
      <FileDropzone
        id={id}
        file={file}
        onChange={onChange}
        accept=".pdf,.doc,.docx"
        invalid={invalid}
        hint="PDF or Word, up to 5 MB"
      />
      {hasResume
        ? <p className="text-xs text-muted-foreground">
            {file ? "Replaces your current resume. " : "Current: "}
            <SignedLinkButton path="/api/applications/me/resume">
              view uploaded resume
            </SignedLinkButton>
          </p>
        : null}
    </div>
  );
}

// A form section: a heading on the left, its fields on the right (stacked
// above each other on phones). `single` keeps the fields in one column.
function Section({ title, single = false, children }) {
  return (
    <section className="grid gap-4 md:grid-cols-[10rem_1fr] md:gap-8">
      <h2 className="text-base font-semibold">{title}</h2>
      <div
        className={cn("grid gap-4", single ? "grid-cols-1" : "sm:grid-cols-2")}
      >
        {children}
      </div>
    </section>
  );
}

function isWide(field) {
  return (
    ["multiselect", "textarea", "checkbox"].includes(field.type) ||
    Boolean(field.description) ||
    (field.label || "").length > 70
  );
}

// A checkbox with its sentence, for yes/no statements.
function CheckRow({ id, checked, onChange, invalid, children }) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        aria-invalid={invalid || undefined}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="font-normal leading-snug">
        <span>{children}</span>
      </Label>
    </div>
  );
}

// A single-choice dropdown over a list of strings. Optional questions get a
// "No answer" row so a choice can be taken back.
function ChoiceSelect({ id, value, onChange, options, required, invalid }) {
  return (
    <Select
      value={value || ""}
      onValueChange={(v) => onChange(v === NONE ? "" : v)}
    >
      <SelectTrigger
        id={id}
        className="w-full"
        aria-invalid={invalid || undefined}
      >
        <SelectValue placeholder="Select" />
      </SelectTrigger>
      <SelectContent position="popper">
        {required ? null : <SelectItem value={NONE}>No answer</SelectItem>}
        {options.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {opt}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DynamicField({ id, field, value, onChange, error }) {
  if (field.type === "checkbox") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={id}
            checked={Boolean(value)}
            aria-invalid={Boolean(error) || undefined}
            onCheckedChange={(v) => onChange(v === true)}
            className="mt-0.5"
          />
          <Label htmlFor={id} className="font-normal leading-snug">
            <span>
              <RichText text={field.label} />
              {field.required
                ? <span aria-hidden="true" className="text-destructive">
                    {" "}
                    *
                  </span>
                : null}
            </span>
          </Label>
        </div>
        <Description text={field.description} />
        <FieldError id={id} error={error} />
      </div>
    );
  }

  if (field.type === "multiselect") {
    return (
      <ChoiceGroup
        id={id}
        field={field}
        error={error}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
      />
    );
  }

  if (field.type === "select" && field.allowOther) {
    return (
      <SelectWithOther
        id={id}
        field={field}
        error={error}
        value={value}
        onChange={onChange}
      />
    );
  }

  return (
    <Field
      id={id}
      label={field.label}
      required={field.required}
      description={field.description}
      error={error}
    >
      {field.type === "select"
        ? <ChoiceSelect
            id={id}
            value={value || ""}
            options={field.options || []}
            required={field.required}
            invalid={Boolean(error)}
            onChange={onChange}
          />
        : field.type === "textarea"
          ? <Textarea
              id={id}
              value={value || ""}
              aria-invalid={Boolean(error) || undefined}
              onChange={(e) => onChange(e.target.value)}
            />
          : <Input
              id={id}
              type={
                field.type === "number"
                  ? "number"
                  : field.type === "date"
                    ? "date"
                    : "text"
              }
              value={value || ""}
              aria-invalid={Boolean(error) || undefined}
              onChange={(e) => onChange(e.target.value)}
            />}
    </Field>
  );
}

// "Select all that apply": a checkbox per option, plus an "Other" box with
// free text when the question allows it. The answer is the list of choices,
// with the Other text (if ticked and filled in) as the one extra entry.
function ChoiceGroup({ id, field, value, onChange, error }) {
  const options = field.options || [];
  const chosen = value.filter((v) => options.includes(v));
  const [otherOn, setOtherOn] = useState(() =>
    value.some((v) => !options.includes(v)),
  );
  const [otherText, setOtherText] = useState(
    () => value.find((v) => !options.includes(v)) || "",
  );

  // Choices are kept in the question's option order, whatever the click order.
  function emit(nextChosen, on, text) {
    const ordered = options.filter((opt) => nextChosen.includes(opt));
    onChange(on && text.trim() ? [...ordered, text.trim()] : ordered);
  }

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm leading-snug font-medium">
        <RichText text={field.label} />
        {field.required
          ? <span aria-hidden="true" className="text-destructive">
              {" "}
              *
            </span>
          : null}
      </legend>
      <Description text={field.description} />
      <div className="grid gap-2">
        {options.map((opt, index) => (
          <CheckRow
            key={opt}
            id={`${id}-${index}`}
            checked={chosen.includes(opt)}
            invalid={Boolean(error) && index === 0}
            onChange={(on) =>
              emit(
                on ? [...chosen, opt] : chosen.filter((v) => v !== opt),
                otherOn,
                otherText,
              )
            }
          >
            {opt}
          </CheckRow>
        ))}
        {field.allowOther
          ? <div className="flex items-center gap-2.5">
              <Checkbox
                id={`${id}-other`}
                checked={otherOn}
                onCheckedChange={(v) => {
                  setOtherOn(v === true);
                  emit(chosen, v === true, otherText);
                }}
              />
              <Label htmlFor={`${id}-other`} className="font-normal">
                Other
              </Label>
              <Input
                aria-label={`${plainText(field.label)}: other`}
                value={otherText}
                maxLength={300}
                className="h-8 max-w-60"
                onChange={(e) => {
                  setOtherText(e.target.value);
                  setOtherOn(true);
                  emit(chosen, true, e.target.value);
                }}
              />
            </div>
          : null}
      </div>
      <FieldError id={id} error={error} />
    </fieldset>
  );
}

// A single-choice question with an "Other" choice that reveals a text box.
// The answer is the chosen option, or the typed text.
function SelectWithOther({ id, field, value, onChange, error }) {
  const options = field.options || [];
  const OTHER = "__other__";
  const [otherOn, setOtherOn] = useState(
    () => Boolean(value) && !options.includes(value),
  );
  const [otherText, setOtherText] = useState(() =>
    value && !options.includes(value) ? value : "",
  );

  return (
    <Field
      id={id}
      label={field.label}
      required={field.required}
      description={field.description}
      error={error}
    >
      <Select
        value={otherOn ? OTHER : value || ""}
        onValueChange={(v) => {
          if (v === NONE) {
            setOtherOn(false);
            onChange("");
            return;
          }
          const picked = v === OTHER;
          setOtherOn(picked);
          onChange(picked ? otherText : v);
        }}
      >
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={Boolean(error) || undefined}
        >
          <SelectValue placeholder="Select" />
        </SelectTrigger>
        <SelectContent position="popper">
          {field.required
            ? null
            : <SelectItem value={NONE}>No answer</SelectItem>}
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
          <SelectItem value={OTHER}>Other</SelectItem>
        </SelectContent>
      </Select>
      {otherOn
        ? <Input
            aria-label={`${plainText(field.label)}: other`}
            placeholder="Please specify"
            value={otherText}
            maxLength={300}
            onChange={(e) => {
              setOtherText(e.target.value);
              onChange(e.target.value);
            }}
          />
        : null}
    </Field>
  );
}

function Description({ text }) {
  if (!text) return null;
  return (
    <p className="text-[0.8rem] wrap-anywhere whitespace-pre-wrap text-muted-foreground">
      <RichText text={text} />
    </p>
  );
}

function FieldError({ id, error }) {
  if (!error) return null;
  return (
    <p id={`${id}-error`} className="text-[0.8rem] text-destructive">
      {error}
    </p>
  );
}

// Label, optional help text, the control, and its error underneath.
function Field({ id, label, required, description, error, wide, children }) {
  return (
    <div className={cn("grid content-start gap-1.5", wide && "sm:col-span-2")}>
      <Label htmlFor={id} className="leading-snug">
        <span>
          <RichText text={label} />
          {required
            ? <span aria-hidden="true" className="text-destructive">
                {" "}
                *
              </span>
            : null}
        </span>
      </Label>
      <Description text={description} />
      {children}
      <FieldError id={id} error={error} />
    </div>
  );
}
