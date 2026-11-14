"use client";

import { Copy, Download, ListFilter, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import SetupReminderButton from "@/components/SetupReminderButton";
import {
  BarList,
  downloadFile,
  Kpi,
  number,
  Panel,
  percent,
} from "@/components/StatsParts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { apiFetch } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";
import { useUser } from "@/lib/userContext";
import { cn } from "@/lib/utils";

// Admin User groups: pick a segment of one round's applicants (email domain,
// status, dietary needs, any choice question on the form, check-in, flag),
// see who is in it at a glance, then download it or copy the emails. The
// filters are built from the round's own form, so this works for any event.

const STATUSES = [
  ["accepted", "Accepted"],
  ["pending", "Pending"],
  ["waitlisted", "Waitlisted"],
  ["rejected", "Rejected"],
  ["draft", "Draft"],
];

const DIETARY = [
  ["all", "Everyone"],
  ["any", "Any dietary need"],
  ["restrictions", "Lists a food restriction"],
  ["accommodations", "Needs meal accommodations"],
  ["none", "No dietary needs"],
];

const YES_NO = [
  ["all", "Everyone"],
  ["true", "Yes"],
  ["false", "No"],
];

const EMPTY_FILTERS = {
  domains: [],
  subdomains: false,
  statuses: [],
  dietary: "all",
  checkedIn: "all",
  flagged: "all",
  answers: {},
};

// The query string for a set of filters (the same for the summary, the CSV
// and the email list).
function filterQuery(round, filters) {
  const q = new URLSearchParams();
  if (round) q.set("round", round);
  for (const d of filters.domains) q.append("domain", d);
  if (filters.domains.length && filters.subdomains) q.set("subdomains", "true");
  for (const s of filters.statuses) q.append("status", s);
  if (filters.dietary !== "all") q.set("dietary", filters.dietary);
  if (filters.checkedIn !== "all") q.set("checkedIn", filters.checkedIn);
  if (filters.flagged !== "all") q.set("flagged", filters.flagged);
  for (const [key, values] of Object.entries(filters.answers)) {
    for (const v of values) q.append("answer", `${key}:${v}`);
  }
  return q.toString();
}

function activeCount(filters) {
  return (
    (filters.domains.length ? 1 : 0) +
    (filters.statuses.length ? 1 : 0) +
    (filters.dietary !== "all" ? 1 : 0) +
    (filters.checkedIn !== "all" ? 1 : 0) +
    (filters.flagged !== "all" ? 1 : 0) +
    Object.values(filters.answers).filter((v) => v.length).length
  );
}

function toggle(list, value) {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

function chart(rows) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return { total, buckets: rows, other: { distinct: 0, count: 0 } };
}

export default function UserGroupsPage() {
  const user = useUser();
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const [round, setRound] = useState("");
  const [options, setOptions] = useState(null);
  const [optionsError, setOptionsError] = useState("");
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [group, setGroup] = useState(null);
  const [groupError, setGroupError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState("");
  const latest = useRef(0);

  useEffect(() => {
    if (!isAdmin) router.replace("/dashboard");
  }, [isAdmin, router]);

  const loadOptions = useCallback(async () => {
    setOptionsError("");
    try {
      const data = await apiFetch(
        `/api/admin/groups/options${round ? `?round=${encodeURIComponent(round)}` : ""}`,
      );
      setOptions(data);
    } catch (err) {
      setOptionsError(err.message);
    }
  }, [round]);

  useEffect(() => {
    if (isAdmin) loadOptions();
  }, [isAdmin, loadOptions]);

  // The round the options are for (the default one when none was picked).
  const roundId = options?.round?._id || "";
  const queryString = filterQuery(roundId, filters);

  // Only the newest request may update the page, so a slow response for an
  // old filter can't overwrite a newer one.
  const loadGroup = useCallback(async () => {
    if (!roundId) return;
    const mine = ++latest.current;
    setRefreshing(true);
    try {
      const data = await apiFetch(`/api/admin/groups?${queryString}`);
      if (mine !== latest.current) return;
      setGroup(data);
      setGroupError("");
    } catch (err) {
      if (mine !== latest.current) return;
      setGroupError(err.message);
    } finally {
      if (mine === latest.current) setRefreshing(false);
    }
  }, [roundId, queryString]);

  useEffect(() => {
    if (isAdmin) loadGroup();
  }, [isAdmin, loadGroup]);

  if (!isAdmin) return null;

  function update(patch) {
    setFilters((current) => ({ ...current, ...patch }));
  }

  function changeRound(value) {
    // Questions differ between rounds, so their filters are dropped.
    setFilters((current) => ({ ...current, answers: {} }));
    setGroup(null);
    setRound(value);
  }

  async function download() {
    setBusy("csv");
    try {
      await downloadFile(
        `/api/admin/groups/export.csv?${queryString}`,
        "user-group.csv",
      );
    } catch (err) {
      notifyError(err, { title: "Couldn't download the group" });
    } finally {
      setBusy("");
    }
  }

  async function copyEmails() {
    setBusy("emails");
    try {
      const data = await apiFetch(`/api/admin/groups/emails?${queryString}`);
      await navigator.clipboard.writeText(data.emails.join(", "));
      notifySuccess(
        `Copied ${number(data.emails.length)} email${data.emails.length === 1 ? "" : "s"}`,
      );
    } catch (err) {
      notifyError(err, { title: "Couldn't copy the emails" });
    } finally {
      setBusy("");
    }
  }

  const noRounds = options && !options.round;
  const total = group?.total || 0;
  const canExport = Boolean(roundId) && total > 0 && !busy;

  return (
    <div>
      <PageHeader
        title="User groups"
        description={
          options?.round
            ? `Applicants in ${options.round.name}. Filters combine: everyone shown matches all of them.`
            : null
        }
        actions={
          <>
            <SetupReminderButton />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canExport}
              loading={busy === "emails"}
              onClick={copyEmails}
            >
              <Copy aria-hidden="true" />
              Copy emails
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canExport}
              loading={busy === "csv"}
              onClick={download}
            >
              <Download aria-hidden="true" />
              Download CSV
            </Button>
          </>
        }
      />

      {optionsError
        ? <Alert variant="destructive" className="mb-4">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              Couldn&apos;t load the filters: {optionsError}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={loadOptions}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        : null}

      {!options && !optionsError
        ? <GroupsSkeleton />
        : noRounds
          ? <EmptyState
              icon={ListFilter}
              title="No application rounds yet."
              description="Groups are made from a round's applicants. Create a round in Settings first."
            />
          : options
            ? <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
                <Filters
                  options={options}
                  round={roundId}
                  onRoundChange={changeRound}
                  filters={filters}
                  update={update}
                  onClear={() => setFilters(EMPTY_FILTERS)}
                />
                <div
                  className={cn(
                    "min-w-0 space-y-6 transition-opacity",
                    refreshing && "opacity-60",
                  )}
                  aria-busy={refreshing}
                >
                  {groupError
                    ? <Alert variant="destructive">
                        <AlertDescription className="flex flex-wrap items-center gap-2">
                          {groupError}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={loadGroup}
                          >
                            Try again
                          </Button>
                        </AlertDescription>
                      </Alert>
                    : null}
                  {group
                    ? <Results
                        group={group}
                        onClear={() => setFilters(EMPTY_FILTERS)}
                        filtered={activeCount(filters) > 0}
                      />
                    : groupError
                      ? null
                      : <ResultsSkeleton />}
                </div>
              </div>
            : null}
    </div>
  );
}

function GroupsSkeleton() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]"
      aria-busy="true"
    >
      <Skeleton className="h-96 w-full rounded-xl" />
      <ResultsSkeleton />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="grid gap-4 2xl:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="border-t pt-4 first:border-t-0 first:pt-0">
      <fieldset className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-medium">{title}</legend>
        {children}
      </fieldset>
    </div>
  );
}

function CheckRow({ checked, onChange, label, count }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5"
      />
      <Label
        htmlFor={id}
        className="flex min-w-0 flex-1 justify-between gap-2 font-normal leading-snug"
      >
        <span className="min-w-0 break-words">{label}</span>
        {count === undefined
          ? null
          : <span className="text-xs text-muted-foreground tabular-nums">
              {number(count)}
            </span>}
      </Label>
    </div>
  );
}

function ChoiceSelect({ id, label, value, onChange, choices }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-sm font-medium">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function Filters({ options, round, onRoundChange, filters, update, onClear }) {
  const [domainText, setDomainText] = useState("");
  const [domainError, setDomainError] = useState("");
  const domainId = useId();
  const active = activeCount(filters);

  function addDomain(event) {
    event.preventDefault();
    const domain = domainText.trim().toLowerCase().replace(/^.*@/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      setDomainError("Enter a domain, like example.edu.");
      return;
    }
    setDomainError("");
    setDomainText("");
    if (!filters.domains.includes(domain)) {
      update({ domains: [...filters.domains, domain] });
    }
  }

  function setAnswer(key, values) {
    const answers = { ...filters.answers, [key]: values };
    if (!values.length) delete answers[key];
    update({ answers });
  }

  return (
    <Card size="sm" className="h-fit">
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Filters</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!active}
            onClick={onClear}
          >
            Clear{active ? ` (${active})` : ""}
          </Button>
        </div>

        <Section title="Round">
          <Select value={round} onValueChange={onRoundChange}>
            <SelectTrigger size="sm" aria-label="Round" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.rounds.map((r) => (
                <SelectItem key={r._id} value={r._id}>
                  {r.name}
                  {r.isOpen ? " (open)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        <Section title="Email domain">
          <form onSubmit={addDomain} className="flex gap-2" noValidate>
            <Label htmlFor={domainId} className="sr-only">
              Email domain
            </Label>
            <Input
              id={domainId}
              value={domainText}
              onChange={(e) => setDomainText(e.target.value)}
              placeholder="example.edu"
              aria-invalid={domainError ? true : undefined}
              className="h-8"
            />
            <Button type="submit" variant="outline" size="sm">
              <Plus aria-hidden="true" />
              Add
            </Button>
          </form>
          {domainError
            ? <p className="text-xs text-destructive">{domainError}</p>
            : null}
          {filters.domains.length
            ? <ul className="flex flex-wrap gap-1.5">
                {filters.domains.map((d) => (
                  <li key={d}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="xs"
                      aria-label={`Remove ${d}`}
                      onClick={() =>
                        update({
                          domains: filters.domains.filter((x) => x !== d),
                        })
                      }
                    >
                      {d}
                      <X aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            : null}
          <div className="flex items-center gap-2">
            <Switch
              id={`${domainId}-subdomains`}
              size="sm"
              checked={filters.subdomains}
              onCheckedChange={(on) => update({ subdomains: on })}
            />
            <Label
              htmlFor={`${domainId}-subdomains`}
              className="text-sm font-normal"
            >
              Include subdomains
            </Label>
          </div>
          {options.domains.length
            ? <details className="text-sm" open>
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Top domains
                </summary>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {options.domains.map((d) => {
                    const on = filters.domains.includes(d.domain);
                    return (
                      <li key={d.domain}>
                        <Button
                          type="button"
                          variant={on ? "secondary" : "outline"}
                          size="xs"
                          aria-pressed={on}
                          onClick={() =>
                            update({
                              domains: toggle(filters.domains, d.domain),
                            })
                          }
                        >
                          {d.domain}
                          <span className="text-muted-foreground tabular-nums">
                            {number(d.count)}
                          </span>
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </details>
            : null}
        </Section>

        <Section title="Status">
          <p className="text-xs text-muted-foreground">
            None ticked means every submitted application.
          </p>
          {STATUSES.map(([value, label]) => (
            <CheckRow
              key={value}
              label={label}
              count={options.statuses[value]}
              checked={filters.statuses.includes(value)}
              onChange={() =>
                update({ statuses: toggle(filters.statuses, value) })
              }
            />
          ))}
        </Section>

        <Section title="Dietary and event">
          <ChoiceSelect
            id="group-dietary"
            label="Dietary needs"
            value={filters.dietary}
            onChange={(v) => update({ dietary: v })}
            choices={
              options.mealQuestions.length
                ? DIETARY
                : DIETARY.filter(([v]) => v !== "accommodations")
            }
          />
          <p className="text-xs text-muted-foreground">
            Food restrictions of none, n/a or no count as no restriction.
            {options.mealQuestions.length
              ? ` Meal accommodations: a yes to "${options.mealQuestions[0].label}".`
              : ""}
          </p>
          <ChoiceSelect
            id="group-checked-in"
            label="Checked in"
            value={filters.checkedIn}
            onChange={(v) => update({ checkedIn: v })}
            choices={YES_NO}
          />
          <ChoiceSelect
            id="group-flagged"
            label="Flagged"
            value={filters.flagged}
            onChange={(v) => update({ flagged: v })}
            choices={YES_NO}
          />
        </Section>

        {options.questions.length
          ? <Section title="Form answers">
              <p className="text-xs text-muted-foreground">
                Choices of one question match either; different questions must
                all match.
              </p>
              {options.questions.map((q) => {
                const chosen = filters.answers[q.key] || [];
                return (
                  <details
                    key={q.key}
                    className="rounded-lg border px-3 py-2"
                    open={chosen.length > 0 || undefined}
                  >
                    <summary className="cursor-pointer text-sm">
                      {q.label}
                      {chosen.length
                        ? <span className="ml-1.5 text-xs text-muted-foreground">
                            ({chosen.length} chosen)
                          </span>
                        : null}
                    </summary>
                    <div className="mt-2 space-y-2">
                      {q.values.map((v) => (
                        <CheckRow
                          key={v.value}
                          label={v.value}
                          count={v.count}
                          checked={chosen.includes(v.value)}
                          onChange={() =>
                            setAnswer(q.key, toggle(chosen, v.value))
                          }
                        />
                      ))}
                    </div>
                  </details>
                );
              })}
            </Section>
          : null}
      </CardContent>
    </Card>
  );
}

function Results({ group, onClear, filtered }) {
  const total = group.total;
  if (!total) {
    return (
      <Card size="sm">
        <EmptyState
          icon={ListFilter}
          title="Nobody matches these filters."
          description={
            filtered
              ? "Remove a filter to widen the group."
              : "This round has no submitted applications yet."
          }
          action={
            filtered
              ? <Button type="button" variant="outline" onClick={onClear}>
                  Clear filters
                </Button>
              : null
          }
        />
      </Card>
    );
  }

  const statusChart = chart(
    STATUSES.map(([key, label]) => ({
      label,
      count: group.byStatus[key] || 0,
    })).filter((row) => row.count > 0),
  );
  const dietaryChart = chart([
    { label: "Food restriction", count: group.dietary.restrictions },
    { label: "Meal accommodations", count: group.dietary.accommodations },
    { label: "Neither", count: group.dietary.none },
  ]);
  const checkedInChart = chart([
    { label: "Checked in", count: group.checkedIn.yes },
    { label: "Not checked in", count: group.checkedIn.no },
  ]);

  const kpis = [
    { label: "Matching applicants", value: total, note: group.round.name },
    {
      label: "Accepted",
      value: group.byStatus.accepted,
      note: `${percent(group.byStatus.accepted, total)} of the group`,
    },
    {
      label: "Dietary needs",
      value: group.dietary.any,
      note: `${percent(group.dietary.any, total)} of the group`,
    },
    {
      label: "Checked in",
      value: group.checkedIn.yes,
      note: group.flagged.yes ? `${number(group.flagged.yes)} flagged` : null,
    },
  ];

  return (
    <>
      <div
        className="grid grid-cols-2 overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 sm:grid-cols-4 [&>*]:border-r [&>*]:border-b [&>*]:border-border"
        aria-live="polite"
      >
        {kpis.map((kpi) => (
          <Kpi key={kpi.label} {...kpi} />
        ))}
      </div>

      <div className="grid gap-4 2xl:grid-cols-2">
        <Panel title="Status">
          <BarList chart={statusChart} />
        </Panel>
        <Panel title="Email domain">
          <BarList chart={group.byDomain} otherLabel="more domains" />
        </Panel>
        <Panel title="School">
          <BarList chart={group.byUniversity} otherLabel="more schools" />
        </Panel>
        <Panel title="T-shirt size">
          <BarList chart={group.byTshirtSize} otherLabel="more" />
        </Panel>
        <Panel
          title="Dietary needs"
          description="Someone can have both, so the rows can add up to more than the group."
        >
          <BarList chart={{ ...dietaryChart, total }} />
        </Panel>
        <Panel title="Checked in">
          <BarList chart={checkedInChart} />
        </Panel>
      </div>
      <p className="text-xs text-muted-foreground">
        The CSV and copied emails contain personal information. Share them only
        with people who need them.
      </p>
    </>
  );
}
