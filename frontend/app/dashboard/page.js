"use client";

import { ArrowRight, CircleCheck, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  removed: "Withdrawn",
};

// Discord authorization URL; Discord returns an OAuth `code` to this page.
const DISCORD_AUTH_URL =
  "https://discord.com/oauth2/authorize?client_id=1570979274213687378&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fdashboard&scope=identify";

export default function DashboardHome() {
  const user = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const discordCode = searchParams.get("code");
  const discordCallbackStarted = useRef(false);
  const [state, setState] = useState({
    loading: true,
    round: null,
    application: null,
    latest: null,
  });
  const [qr, setQr] = useState(null);
  const [links, setLinks] = useState(null);
  // Track the local link result so the UI updates after the callback completes.
  const [discordLinked, setDiscordLinked] = useState(Boolean(user.discordId));
  const [discordResponse, setDiscordResponse] = useState(user.discordId || null);
  const [discordCallbackComplete, setDiscordCallbackComplete] = useState(false);
  const [attemptFailed, setAttemptFailed] = useState(false);

  useEffect(() => {
    if (user.role === "judge") {
      router.replace("/dashboard/judging");
      return;
    }

    // Exchange Discord's returned code for the authenticated user's Discord ID.
    if (discordCode && !discordCallbackStarted.current) {
      discordCallbackStarted.current = true;
      apiFetch("/api/discord/callback", {
        method: "POST",
        body: JSON.stringify({ code: discordCode }),
      })
        .then((data) => {
          setDiscordResponse(data.user || null);
          setDiscordLinked(true);
          window.history.replaceState({}, "", window.location.pathname);
        })
        .catch(() => setAttemptFailed(true))
        .finally(() => setDiscordCallbackComplete(true));
    }

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
  }, [discordCode, user.role, router]);

  // What the application card shows. With no open round, your standing from
  // any round. With a round open, your application in it; but if you have
  // none there and were already accepted in an earlier round, that acceptance
  // (an attendee shouldn't be told to apply again).
  const latestAccepted =
    state.latest?.application?.status === "accepted" ? state.latest : null;
  const standing = state.application?.removedAt
    ? { application: { status: "removed" }, round: state.round }
    : !state.round
      ? state.latest || { none: true }
      : !state.application
        ? latestAccepted
        : null;

  const shownApplication = standing?.application || state.application;
  const shownRound = standing?.round || state.round;

  // The shared shell also guards dashboard URLs. Keep attendee cards hidden
  // while the judge home redirect completes.
  if (user.role === "judge") return null;

  return (
    <div>
      {discordCode && !discordCallbackComplete
        ? <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            <Card className="w-full max-w-sm shadow-xl">
              <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
                <Loader2 className="size-8 animate-spin text-primary" aria-hidden="true" />
                <div>
                  <p className="font-semibold">Linking your Discord account</p>
                  <p className="text-sm text-muted-foreground">
                    Please wait while we finish connecting your account.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        : null}
      <PageHeader title={user.name.split(" ")[0]} description={user.email} />

      <WorkshopHomeUpdates />
      <div className="grid items-start gap-4 lg:grid-cols-2">
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
        <Card>
              <CardHeader>
                <CardTitle>Community</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="rounded-lg border bg-muted/30 p-4">
                  <p className="font-medium">Discord</p>
                  {/* Show relinking controls when an account is already linked. */}
                  {discordLinked
                    ? <div className="mt-1 flex items-center gap-3">
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <p className="text-sm text-success">
                                Discord Account Linked
                              </p>
                            </TooltipTrigger>
                            {discordResponse
                              ? <TooltipContent
                                  side="bottom"
                                  sideOffset={0}
                                  collisionPadding={8}
                                  className="max-w-[calc(100vw-2rem)] break-all px-2 py-1 text-[10px]"
                                >
                                  Discord ID: {discordResponse}
                                </TooltipContent>
                              : null}
                          </Tooltip>
                        </TooltipProvider>
                        <a
                          className="text-sm text-link hover:underline"
                          href={DISCORD_AUTH_URL}
                        >
                          Link a different Discord account
                        </a>
                      </div>
                    : <div className="mt-3 flex items-center gap-3">
                        <Button asChild>
                          <a href={DISCORD_AUTH_URL}>Link Discord Account</a>
                        </Button>
                        {attemptFailed
                          ? <p className="text-sm text-destructive">
                              Failed to Link Discord. Please try again.
                            </p>
                          : null}
                      </div>}
                </div>
                {links?.discordUrl
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
                  
                {links?.mentorshipUrl
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
      </div>
    </div>
  );
}
