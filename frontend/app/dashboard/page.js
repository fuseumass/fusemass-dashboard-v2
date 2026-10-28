"use client";

import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import ApplicationStatusBadge from "@/components/ApplicationStatusBadge";
import ClosedRoundStatus from "@/components/ClosedRoundStatus";
import PageHeader from "@/components/PageHeader";
import { CardSkeleton } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import WorkshopHomeUpdates from "@/components/WorkshopHomeUpdates";
import { apiFetch } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { useUser } from "@/lib/userContext";

const STATUS_LABELS = {
  draft: "Draft",
  pending: "In review",
  accepted: "Accepted",
  rejected: "Not accepted",
  waitlisted: "Waitlisted",
};

export default function DashboardHome() {
  const user = useUser();
  const [state, setState] = useState({
    loading: true,
    round: null,
    application: null,
    latest: null,
  });
  const [qr, setQr] = useState(null);
  const [links, setLinks] = useState(null);

  useEffect(() => {
    // Discord invite and the optional mentorship link (tickets live on Discord).
    apiFetch("/api/meta/links")
      .then((data) => setLinks(data.links))
      .catch(() => setLinks(null));
    apiFetch("/api/applications/me")
      .then((data) =>
        setState({
          loading: false,
          round: data.round,
          application: data.application,
          latest: data.latest,
        }),
      )
      .catch(() =>
        setState({
          loading: false,
          round: null,
          application: null,
          latest: null,
        }),
      );
    // Fetched on its own rather than off the open round's application: on
    // event day applications are closed, and that is exactly when it's needed.
    apiFetch("/api/applications/me/qr")
      .then((data) => setQr(data))
      .catch(() => setQr(null));
  }, []);

  // What the application card shows. With no open round, your standing from
  // any round. With a round open, your application in it; but if you have
  // none there and were already accepted in an earlier round, that acceptance
  // (an attendee shouldn't be told to apply again).
  const latestAccepted =
    state.latest?.application?.status === "accepted" ? state.latest : null;
  const standing = !state.round
    ? state.latest || { none: true }
    : !state.application
      ? latestAccepted
      : null;

  const shownApplication = standing?.application || state.application;
  const shownRound = standing?.round || state.round;

  return (
    <div>
      <PageHeader title={user.name.split(" ")[0]} description={user.email} />

      <WorkshopHomeUpdates />
      <div className="grid items-start gap-4 md:grid-cols-2">
        {state.loading
          ? <CardSkeleton lines={2} />
          : <Card>
              <CardHeader>
                <CardTitle>Application</CardTitle>
                {shownApplication
                  ? <CardAction>
                      <ApplicationStatusBadge
                        status={shownApplication.status}
                        label={
                          STATUS_LABELS[shownApplication.status] ||
                          shownApplication.status
                        }
                      />
                    </CardAction>
                  : null}
                {shownRound
                  ? <CardDescription>{shownRound.name}</CardDescription>
                  : null}
              </CardHeader>
              <CardContent className="space-y-4">
                {standing
                  ? <ClosedRoundStatus latest={standing} />
                  : !state.application
                    ? <>
                        <p className="text-muted-foreground">
                          {`Applications for the ${state.round.name} round are open.`}
                        </p>
                        <Button asChild>
                          <Link href="/dashboard/application">
                            Start your application
                          </Link>
                        </Button>
                      </>
                    : <Button asChild variant="outline">
                        <Link href="/dashboard/application">
                          View or edit your application
                          <ArrowRight
                            data-icon="inline-end"
                            aria-hidden="true"
                          />
                        </Link>
                      </Button>}
              </CardContent>
            </Card>}

        {qr
          ? <Card>
              <CardHeader>
                <CardTitle>Your check-in QR code</CardTitle>
                <CardDescription>
                  Show this at event check-in and at every meal. It&apos;s the
                  same code as in your acceptance email.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {user.checkedIn && !standing?.checkedIn
                  ? <p className="flex items-center gap-1.5 font-medium text-success">
                      <CircleCheck className="size-4" aria-hidden="true" />
                      You&apos;re checked in
                      {user.checkedInAt
                        ? ` (${formatDateTime(user.checkedInAt)})`
                        : ""}
                    </p>
                  : null}
                {/* A data: URL generated by the API; next/image adds nothing here. */}
                {/* biome-ignore lint/performance/noImgElement: data URL, not a static asset */}
                <img
                  src={qr.qrCode}
                  alt="Your check-in QR code"
                  width={240}
                  height={240}
                  className="block size-60 rounded-md bg-white"
                />
              </CardContent>
            </Card>
          : null}
        {links && (links.discordUrl || links.mentorshipUrl)
          ? <Card>
              <CardHeader>
                <CardTitle>Community</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {links.discordUrl
                  ? <div>
                      <a
                        className="font-medium text-link hover:underline"
                        href={links.discordUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Join the Discord
                      </a>
                      <p className="text-sm text-muted-foreground">
                        Announcements, and a place to meet other hackers.
                      </p>
                    </div>
                  : null}
                {links.mentorshipUrl
                  ? <div>
                      <a
                        className="font-medium text-link hover:underline"
                        href={links.mentorshipUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Ask a mentor on Discord
                      </a>
                      <p className="text-sm text-muted-foreground">
                        Stuck? Open a mentorship ticket and a mentor will pick
                        it up.
                      </p>
                    </div>
                  : null}
              </CardContent>
            </Card>
          : null}
      </div>
    </div>
  );
}
