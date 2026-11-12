"use client";

import { Eye } from "lucide-react";
import EmptyState from "@/components/EmptyState";
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
 * @returns {JSX.Element}
 */
export default function AnnouncementPreview({ preview }) {
  const embed = preview?.discord?.embeds?.[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-semibold">Preview</CardTitle>
        <CardDescription>
          {preview?.audience
            ? `${preview.audience.label}: ${preview.audience.recipients} will get the email${
                preview.audience.skippedOptOut
                  ? `, ${preview.audience.skippedOptOut} turned announcements off`
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
        {embed
          ? <section aria-label="Discord preview" className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                Discord
              </p>
              <div className="rounded-md bg-muted p-3">
                {preview.discord.content
                  ? <p className="mb-2 text-sm font-medium text-info">
                      {preview.discord.content}
                    </p>
                  : null}
                <div className="rounded-sm border-l-4 border-brand bg-card p-3">
                  <p className="text-sm font-semibold wrap-anywhere">
                    {embed.url
                      ? <span className="text-link">{embed.title}</span>
                      : embed.title}
                  </p>
                  <p className="mt-1 text-sm whitespace-pre-wrap wrap-anywhere text-foreground">
                    {embed.description}
                  </p>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {preview.discord.allowed_mentions.parse.length
                    ? "Pings @everyone."
                    : "Nobody is pinged."}
                </p>
              </div>
            </section>
          : null}
      </CardContent>
    </Card>
  );
}
