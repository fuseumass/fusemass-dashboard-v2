"use client";

import { Upload } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api";
import { notifyError, notifySuccess } from "@/lib/notify";

/**
 * Split CSV text into rows of cells. Handles quoted cells with commas,
 * doubled quotes and line breaks.
 * @param {string} text - CSV text.
 * @returns {string[][]} Rows.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/**
 * Group a "team,email" CSV into teams, in file order.
 * @param {string} text - CSV text.
 * @returns {{teams?: {emails: string[]}[], people?: number, error?: string}}
 */
function readTeams(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { error: "The file has no rows." };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const teamCol = header.findIndex((h) => h === "team" || h === "team id");
  const emailCol = header.indexOf("email");
  if (teamCol === -1 || emailCol === -1) {
    return { error: 'The file needs a "team" column and an "email" column.' };
  }
  const order = [];
  const byTeam = {};
  let people = 0;
  for (const row of rows.slice(1)) {
    const team = (row[teamCol] || "").trim();
    const email = (row[emailCol] || "").trim();
    if (!team || !email) continue;
    if (!byTeam[team]) {
      byTeam[team] = [];
      order.push(team);
    }
    byTeam[team].push(email);
    people += 1;
  }
  if (!order.length) return { error: "No rows have both a team and an email." };
  return { teams: order.map((t) => ({ emails: byTeam[t] })), people };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Admin dialog: upload suggested teams (a CSV with team and email columns).
 * For each team the first accepted applicant starts it and everyone else is
 * invited, so people choose whether to join. Always previews first.
 * @param {{open: boolean, onOpenChange: function, onDone: function}} props
 * @returns {JSX.Element}
 */
export default function ImportTeamsDialog({ open, onOpenChange, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setPreview(null);
    setError("");
  }

  async function onFile(e) {
    reset();
    const picked = e.target.files?.[0];
    if (!picked) return;
    const parsed = readTeams(await picked.text());
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setFile(parsed);
    setBusy(true);
    try {
      const res = await apiFetch("/api/admin/team-builder/apply", {
        method: "POST",
        body: JSON.stringify({ imported: parsed.teams, dryRun: true }),
      });
      setPreview(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      const res = await apiFetch("/api/admin/team-builder/apply", {
        method: "POST",
        body: JSON.stringify({ imported: file.teams }),
      });
      notifySuccess(
        `${plural(res.totals.created, "team")} started, ${plural(res.totals.invited, "invite")} sent`,
      );
      reset();
      onOpenChange(false);
      onDone?.();
    } catch (err) {
      notifyError(err, { title: "Couldn't import the teams" });
    } finally {
      setBusy(false);
    }
  }

  // Results come back in file order, one per team.
  const skipped = (preview?.results || []).flatMap((r, i) =>
    r.action === "skipped"
      ? [
          {
            who: file?.teams[i]?.emails.join(", ") || `Team ${i + 1}`,
            reason: r.reason,
          },
        ]
      : r.skipped.map((s) => ({ who: s.email, reason: s.reason })),
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import suggested teams</DialogTitle>
          <DialogDescription>
            Upload a CSV with a team column and an email column, one row per
            person. The first accepted applicant in each team starts it and
            everyone else gets an invite they can accept or decline. People
            already on a team or invited are left alone.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="import-teams-csv">Teams CSV</Label>
          <Input
            id="import-teams-csv"
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            disabled={busy}
          />
        </div>
        {error
          ? <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          : null}
        {preview
          ? <div className="space-y-2 text-sm">
              <p>
                {plural(file.teams.length, "team")} and{" "}
                {plural(file.people, "person")} in the file.{" "}
                {plural(preview.totals.created, "team")} will be started and{" "}
                {plural(preview.totals.invited, "invite")} sent.
              </p>
              {preview.overLimit
                ? <Alert variant="destructive">
                    <AlertDescription>
                      These invites would go over the daily email limit. Import
                      fewer teams or wait.
                    </AlertDescription>
                  </Alert>
                : null}
              {skipped.length
                ? <div className="space-y-1">
                    <p className="font-medium">
                      {plural(skipped.length, "skip")}
                    </p>
                    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2 text-muted-foreground">
                      {skipped.map((s, i) => (
                        <li key={`${s.who}-${i}`} className="break-words">
                          {s.who}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                : null}
            </div>
          : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={busy}
            disabled={
              !preview || preview.overLimit || !preview.totals.created || busy
            }
          >
            <Upload aria-hidden="true" />
            Start teams and send invites
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
