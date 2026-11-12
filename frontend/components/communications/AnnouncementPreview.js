"use client";

import { Eye, TriangleAlert } from "lucide-react";
import EmptyState from "@/components/EmptyState";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * The email and the Discord post exactly as the server will send them.
 * @param {object} props
 * @param {object|null} props.preview - From POST /api/staff/communications/preview.
 * @param {Array<object>} props.tags - Saved Discord mentions, to show role names.
 * @returns {JSX.Element}
 */
export default function AnnouncementPreview({ preview, tags = [] }) {
  const embed = preview?.discord?.embeds?.[0];
  const discord = preview?.discord;
  // Role mentions as the writer typed them: "<@&123>" -> "@participants".
  const named = (text) =>
    String(text || "").replace(/<@&(\d+)>/g, (match, id) => {
      const tag = tags.find((t) => t.roleId === id);
      return tag ? `@${tag.label}` : match;
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">Preview</CardTitle>
        <CardDescription>
          {preview?.audience
            ? `${preview.audience.label}: ${preview.audience.recipients} of ${preview.audience.inAudience} will get the email${
                preview.audience.skippedOptOut
                  ? `, ${preview.audience.skippedOptOut} turned announcements off or never opted in`
                  : ""
              }.`
            : "Rendered by the server, as it will go out."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!preview
          ? <EmptyState
              icon={Eye}
              title="Nothing to preview yet"
              description="Write the announcement and choose Preview."
            />
          : null}
        {preview?.email
          ? <section aria-label="Email preview" className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Email</p>
              <p className="text-sm">
                <span className="text-muted-foreground">Subject: </span>
                <span className="font-medium">{preview.email.subject}</span>
              </p>
              {/* Sandboxed: the HTML is escaped server-side, and the iframe
                  keeps email styling off this page (DESIGN.md exception). */}
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={`<!doctype html><html><body style="margin:0;padding:12px;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#171821;background:#fff">${preview.email.html}</body></html>`}
                className="h-56 w-full rounded-md border border-border bg-white"
              />
            </section>
          : null}
        {discord
          ? <section aria-label="Discord preview" className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Discord
              </p>
              <div className="rounded-md bg-muted p-3">
                {discord.content
                  ? <p className="mb-2 text-sm whitespace-pre-wrap wrap-anywhere text-foreground">
                      {named(discord.content)}
                    </p>
                  : null}
                {embed
                  ? <div className="rounded-sm border-l-4 border-brand bg-card p-3">
                      <p className="text-sm font-semibold wrap-anywhere">
                        {embed.url
                          ? <span className="text-link">{embed.title}</span>
                          : embed.title}
                      </p>
                      <p className="mt-1 text-sm whitespace-pre-wrap wrap-anywhere text-foreground">
                        {named(embed.description)}
                      </p>
                    </div>
                  : null}
              </div>
              {preview.pings?.length
                ? <Alert>
                    <TriangleAlert aria-hidden="true" />
                    <AlertDescription>
                      This notifies {preview.pings.join(", ")}.
                    </AlertDescription>
                  </Alert>
                : <p className="text-xs text-muted-foreground">
                    Nobody is pinged.
                  </p>}
            </section>
          : null}
      </CardContent>
    </Card>
  );
}
