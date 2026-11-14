"use client";

import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { notifySuccess } from "@/lib/notify";

const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLE_ID = /^\d{17,20}$/;

// Check the rows; returns one message per row index, or {}.
function check(rows) {
  const problems = {};
  const seen = new Set();
  rows.forEach((row, i) => {
    const label = row.label.trim().replace(/^@/, "").toLowerCase();
    if (!LABEL.test(label) || label.length > 32) {
      problems[i] = "Use lowercase letters, numbers and dashes for the name.";
    } else if (label === "everyone" || label === "here") {
      problems[i] = "everyone and here are built in.";
    } else if (seen.has(label)) {
      problems[i] = "Each name can be used once.";
    } else if (!ROLE_ID.test(row.roleId.trim())) {
      problems[i] = "The role ID is 17 to 20 digits.";
    }
    seen.add(label);
  });
  return problems;
}

/**
 * Saved Discord role mentions: a short name that writers type as @name, and
 * the role ID it stands for. Admins edit, moderators only see them.
 * @param {object} props
 * @param {Array<object>} props.tags - Saved tags `{ label, roleId }`.
 * @param {boolean} props.canEdit - Admin.
 * @param {function} props.onSaved - Called with the API answer `{ settings, next }`.
 * @returns {JSX.Element}
 */
export default function DiscordMentions({ tags, canEdit, onSaved }) {
  const [rows, setRows] = useState(tags);
  const [problems, setProblems] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows(tags);
  }, [tags]);

  function change(i, key, value) {
    setRows((list) =>
      list.map((row, at) => (at === i ? { ...row, [key]: value } : row)),
    );
    setProblems({});
  }

  async function save(e) {
    e.preventDefault();
    setError("");
    const found = check(rows);
    setProblems(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      const data = await apiFetch("/api/staff/communications/settings", {
        method: "PATCH",
        body: JSON.stringify({
          discordTags: rows.map((row) => ({
            label: row.label.trim().replace(/^@/, "").toLowerCase(),
            roleId: row.roleId.trim(),
          })),
        }),
      });
      notifySuccess("Discord mentions saved");
      onSaved(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <form onSubmit={save} noValidate>
        <CardHeader>
          <CardTitle className="text-base font-semibold">
            Discord mentions
          </CardTitle>
          <CardDescription>
            Write @name in a Discord message and it pings that role. @everyone
            and @here are always available. In Discord, turn on Developer Mode,
            then right-click a role and choose Copy role ID.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0
            ? <p className="text-sm text-muted-foreground">
                {canEdit
                  ? "No saved roles yet. Add one to use it as @name."
                  : "No saved roles yet. An admin can add them here."}
              </p>
            : null}
          {rows.map((row, i) => (
            <div key={`${i}-${rows.length}`} className="space-y-1">
              <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
                <div className="col-span-2 space-y-1 sm:col-span-1">
                  <Label htmlFor={`tag-label-${i}`} className="text-xs">
                    Name
                  </Label>
                  <Input
                    id={`tag-label-${i}`}
                    className="w-full"
                    value={row.label}
                    disabled={!canEdit || saving}
                    placeholder="participants"
                    aria-invalid={Boolean(problems[i]) || undefined}
                    onChange={(e) => change(i, "label", e.target.value)}
                  />
                </div>
                <div className="min-w-0 space-y-1">
                  <Label htmlFor={`tag-role-${i}`} className="text-xs">
                    Role ID
                  </Label>
                  <Input
                    id={`tag-role-${i}`}
                    inputMode="numeric"
                    className="w-full tabular-nums"
                    value={row.roleId}
                    disabled={!canEdit || saving}
                    placeholder="123456789012345678"
                    aria-invalid={Boolean(problems[i]) || undefined}
                    onChange={(e) => change(i, "roleId", e.target.value)}
                  />
                </div>
                {canEdit
                  ? <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove @${row.label || "mention"}`}
                      disabled={saving}
                      onClick={() => {
                        setRows((list) => list.filter((_, at) => at !== i));
                        setProblems({});
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  : null}
              </div>
              {problems[i]
                ? <p className="text-xs text-destructive">{problems[i]}</p>
                : null}
            </div>
          ))}
          {error
            ? <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            : null}
        </CardContent>
        {canEdit
          ? <CardFooter className="justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() =>
                  setRows((list) => [...list, { label: "", roleId: "" }])
                }
              >
                <Plus aria-hidden="true" />
                Add a role
              </Button>
              <Button type="submit" loading={saving}>
                Save mentions
              </Button>
            </CardFooter>
          : null}
      </form>
    </Card>
  );
}
