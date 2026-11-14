"use client";

import { Merge } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import { plainText } from "@/components/RichText";
import SearchInput from "@/components/SearchInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

const FIELD_LABELS = {
  name: "Name",
  phone: "Phone",
  age: "Age",
  gender: "Gender",
  pronouns: "Pronouns",
  education: "Education",
  university: "University",
  major: "Major",
  allergies: "Allergies",
  tshirtSize: "T-shirt size",
  "socials.linkedin": "LinkedIn",
  "socials.github": "GitHub",
  "socials.website": "Website",
  "socials.other": "Other links",
  "experience.attendedBefore": "Has been to a hackathon",
  "experience.hackathonsAttended": "Hackathons attended",
  "experience.attendedThisBefore": "Has been to this event",
  programmingSkills: "Programming skills",
  hardwareSkills: "Hardware skills",
  otherSkills: "Other skills",
  resume: "Resume",
};

// Reads a mergeable field from an application as the API returns it.
function readField(app, field) {
  if (field === "resume") return app.hasResume ? "Uploaded" : "";
  if (field.startsWith("answers.")) {
    return app.answers?.[field.slice("answers.".length)];
  }
  return field.split(".").reduce((value, key) => value?.[key], app);
}

function hasValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function display(value) {
  if (!hasValue(value)) return "Empty";
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object"
          ? `${item.label || "Link"}: ${item.url}`
          : String(item),
      )
      .join(", ");
  }
  return String(value);
}

// The server fills blanks from the other application; the form starts from
// the same rule so what you see is what is saved.
function defaultChoice(kept, other, field) {
  const mine = readField(kept, field);
  const theirs = readField(other, field);
  return !hasValue(mine) && hasValue(theirs) ? "other" : "this";
}

function fieldLabel(field, apps) {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const key = field.slice("answers.".length);
  for (const app of apps) {
    const question = (app.round?.formConfig || []).find((q) => q.key === key);
    if (question) return plainText(question.label);
  }
  return key;
}

function attachmentLines(attachments) {
  const lines = [];
  lines.push(attachments.checkedIn ? "Checked in" : "Not checked in");
  lines.push(
    attachments.team
      ? `Team ${attachments.team.name}${attachments.team.isLeader ? " (leader)" : ""}`
      : "No team",
  );
  lines.push(
    `${attachments.workshopSignups} workshop sign-up${attachments.workshopSignups === 1 ? "" : "s"}`,
  );
  lines.push(
    `${attachments.hardwareLoans} hardware loan${attachments.hardwareLoans === 1 ? "" : "s"}` +
      (attachments.hardwareLoansOpen
        ? `, ${attachments.hardwareLoansOpen} not returned`
        : ""),
  );
  return lines;
}

// Merge two duplicate applications. Step 1: find the other one. Step 2: see
// both side by side, choose which is kept and whose value wins per field.
// `onMerged` receives the API answer ({ application, changed, warnings }).
export function MergeDialog({
  appId,
  initialOtherId,
  open,
  onOpenChange,
  onMerged,
}) {
  const user = useUser();
  const [otherId, setOtherId] = useState(initialOtherId || "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [compare, setCompare] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [keep, setKeep] = useState("this");
  const [choices, setChoices] = useState({});
  const [confirmBoth, setConfirmBoth] = useState(false);
  const [merging, setMerging] = useState(false);

  // Start over whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setOtherId(initialOtherId || "");
      setQuery("");
      setResults(null);
      setCompare(null);
      setError("");
      setConfirmBoth(false);
    }
  }, [open, initialOtherId]);

  // Search by name or email as the staff member types.
  useEffect(() => {
    if (!open || otherId) return undefined;
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch(
        `/api/admin/applications/search?q=${encodeURIComponent(q)}&exclude=${appId}`,
      )
        .then((data) => {
          if (!cancelled) setResults(data.applications);
        })
        .catch((err) => {
          if (!cancelled) setError(err.message);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, otherId, query, appId]);

  // Load the comparison once the other application is chosen.
  useEffect(() => {
    if (!open || !otherId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError("");
    apiFetch(`/api/admin/applications/${appId}/compare?otherId=${otherId}`)
      .then((data) => {
        if (cancelled) return;
        setCompare(data);
        setKeep(data.defaultKeep);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, otherId, appId]);

  // Fields where the two differ, with the starting choice for each. Changes
  // when the kept application changes, because blanks fill from the other.
  const rows = useMemo(() => {
    if (!compare) return [];
    const mine = compare.this.application;
    const theirs = compare.other.application;
    const kept = keep === "this" ? mine : theirs;
    const gone = keep === "this" ? theirs : mine;
    return compare.fields
      .filter(
        (field) =>
          JSON.stringify(readField(mine, field)) !==
          JSON.stringify(readField(theirs, field)),
      )
      .map((field) => {
        const winner = defaultChoice(kept, gone, field);
        const side =
          winner === "this" ? keep : keep === "this" ? "other" : "this";
        return { field, start: side };
      });
  }, [compare, keep]);

  useEffect(() => {
    setChoices(Object.fromEntries(rows.map((r) => [r.field, r.start])));
  }, [rows]);

  const same = compare ? compare.fields.length - rows.length : 0;
  const removedSide = keep === "this" ? "other" : "this";
  const warnings = compare ? compare.warnings[removedSide] : [];
  const apps = compare
    ? [compare.this.application, compare.other.application]
    : [];

  const submit = useCallback(async () => {
    setMerging(true);
    setError("");
    try {
      const data = await apiFetch(`/api/admin/applications/${appId}/merge`, {
        method: "POST",
        body: JSON.stringify({
          otherId,
          keep,
          fields: choices,
          confirmBothCheckedIn: confirmBoth,
        }),
      });
      notifySuccess("Applications merged");
      onOpenChange(false);
      onMerged(data);
    } catch (err) {
      if (err.status === 409 || err.status === 400) setError(err.message);
      else notifyError(err, { title: "Couldn't merge the applications" });
    } finally {
      setMerging(false);
    }
  }, [appId, otherId, keep, choices, confirmBoth, onOpenChange, onMerged]);

  const needsConfirm = Boolean(compare?.bothCheckedIn);
  const canConfirm = user.role === "admin";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Merge with another application</DialogTitle>
          <DialogDescription>
            {compare
              ? "Choose the application to keep and whose value wins for each field that differs. The other application is marked removed."
              : "Search for the other application by name or email."}
          </DialogDescription>
        </DialogHeader>

        {error
          ? <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : null}

        {!otherId
          ? <div className="space-y-3">
              <SearchInput
                label="Search applications"
                placeholder="Name or email"
                value={query}
                autoFocus
                className="sm:w-full"
                onChange={(e) => setQuery(e.target.value)}
              />
              {results === null
                ? <p className="text-sm text-muted-foreground">
                    Type at least two characters.
                  </p>
                : results.length === 0
                  ? <p className="text-sm text-muted-foreground">
                      No other active applications match.
                    </p>
                  : <ul className="divide-y rounded-lg border">
                      {results.map((r) => (
                        <li key={r._id}>
                          <button
                            type="button"
                            className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                            onClick={() => setOtherId(r._id)}
                          >
                            <span className="min-w-0">
                              <span className="block font-medium">
                                {r.name || r.applicant?.name}
                              </span>
                              <span className="block break-all text-xs text-muted-foreground">
                                {r.applicant?.email}
                                {r.round?.name ? `, ${r.round.name}` : ""}
                              </span>
                            </span>
                            <ApplicationStatusBadge status={r.status} />
                          </button>
                        </li>
                      ))}
                    </ul>}
            </div>
          : loading || !compare
            ? <p className="text-sm text-muted-foreground">
                Loading both applications
              </p>
            : <div className="min-w-0 space-y-4">
                <RadioGroup
                  value={keep}
                  onValueChange={setKeep}
                  className="grid gap-3 sm:grid-cols-2"
                  aria-label="Application to keep"
                >
                  {["this", "other"].map((side) => {
                    const a = compare[side].application;
                    return (
                      <Label
                        key={side}
                        htmlFor={`keep-${side}`}
                        className={cn(
                          "items-start gap-3 rounded-lg border p-3 font-normal",
                          keep === side && "border-ring bg-brand/12",
                        )}
                      >
                        <RadioGroupItem
                          id={`keep-${side}`}
                          value={side}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 space-y-1">
                          <span className="block font-medium">
                            Keep {side === "this" ? "this" : "the other"}:{" "}
                            {a.name}
                          </span>
                          <span className="block break-all text-xs text-muted-foreground">
                            {a.applicant?.email}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                            <ApplicationStatusBadge status={a.status} />
                            <span>Applied {formatDateTime(a.createdAt)}</span>
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {a.round?.name}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {attachmentLines(compare[side].attachments).join(
                              ". ",
                            )}
                            .
                          </span>
                        </span>
                      </Label>
                    );
                  })}
                </RadioGroup>

                {warnings.length
                  ? <Alert variant="warning">
                      <AlertDescription className="space-y-1">
                        <p className="font-medium">
                          Nothing is moved to the kept application. Check the
                          removed one's account.
                        </p>
                        <ul className="list-disc space-y-0.5 pl-5">
                          {warnings.map((w) => (
                            <li key={w}>{w}</li>
                          ))}
                        </ul>
                      </AlertDescription>
                    </Alert>
                  : null}

                {needsConfirm
                  ? <Alert variant="destructive">
                      <AlertDescription className="space-y-2">
                        <p>
                          Both applications are accepted and both people are
                          checked in. That is usually two different people.
                        </p>
                        {canConfirm
                          ? <div className="flex items-center gap-2">
                              <Checkbox
                                id="confirm-both"
                                checked={confirmBoth}
                                onCheckedChange={(v) =>
                                  setConfirmBoth(v === true)
                                }
                              />
                              <Label
                                htmlFor="confirm-both"
                                className="font-normal"
                              >
                                I confirm this is one person
                              </Label>
                            </div>
                          : <p>Ask an admin to confirm the merge.</p>}
                      </AlertDescription>
                    </Alert>
                  : null}

                <div className="sm:max-h-[40dvh] sm:overflow-y-auto rounded-lg border">
                  {rows.length === 0
                    ? <p className="p-3 text-sm text-muted-foreground">
                        Every field is the same in both applications.
                      </p>
                    : <ul className="divide-y">
                        {rows.map(({ field }) => (
                          <li key={field} className="space-y-2 p-3">
                            <p className="text-sm font-medium">
                              {fieldLabel(field, apps)}
                            </p>
                            <RadioGroup
                              value={choices[field] || "this"}
                              onValueChange={(v) =>
                                setChoices((prev) => ({ ...prev, [field]: v }))
                              }
                              className="grid gap-2 sm:grid-cols-2"
                              aria-label={fieldLabel(field, apps)}
                            >
                              {["this", "other"].map((side) => {
                                const value = readField(
                                  compare[side].application,
                                  field,
                                );
                                return (
                                  <Label
                                    key={side}
                                    htmlFor={`${field}-${side}`}
                                    className={cn(
                                      "items-start gap-2 rounded-md border p-2 font-normal",
                                      choices[field] === side &&
                                        "border-ring bg-brand/12",
                                    )}
                                  >
                                    <RadioGroupItem
                                      id={`${field}-${side}`}
                                      value={side}
                                      className="mt-0.5"
                                    />
                                    <span className="min-w-0">
                                      <span className="block text-xs text-muted-foreground">
                                        {side === "this"
                                          ? "This application"
                                          : "The other"}
                                      </span>
                                      <span
                                        className={cn(
                                          "block break-words whitespace-pre-wrap",
                                          !hasValue(value) &&
                                            "text-muted-foreground",
                                        )}
                                      >
                                        {display(value)}
                                      </span>
                                    </span>
                                  </Label>
                                );
                              })}
                            </RadioGroup>
                          </li>
                        ))}
                      </ul>}
                </div>
                {same > 0
                  ? <p className="text-xs text-muted-foreground">
                      {same} field{same === 1 ? " is" : "s are"} the same in
                      both and not shown.
                    </p>
                  : null}
              </div>}

        <DialogFooter>
          {otherId && !initialOtherId
            ? <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOtherId("");
                  setCompare(null);
                  setError("");
                }}
              >
                Pick a different application
              </Button>
            : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {compare
            ? <Button
                type="button"
                loading={merging}
                disabled={needsConfirm && !(canConfirm && confirmBoth)}
                onClick={submit}
              >
                <Merge aria-hidden="true" />
                Merge applications
              </Button>
            : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
