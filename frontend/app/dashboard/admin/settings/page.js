"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import AutoAcceptSettings from "@/components/AutoAcceptSettings";
import {
  BrandingCard,
  FeatureSwitches,
} from "@/components/BrandingFeaturesSettings";
import EmailTemplateEditor from "@/components/EmailTemplateEditor";
import {
  AuthSettings,
  CheckInPopupSettings,
  OrganizerRoomSettings,
  TeamSettings,
} from "@/components/GeneralSettings";
import PageHeader from "@/components/PageHeader";
import ReviewSettings from "@/components/ReviewSettings";
import RoundsManager from "@/components/RoundsManager";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUser } from "@/lib/userContext";

const TABS = ["general", "branding", "applications", "email"];

// Admin-only: sign-in, modules, branding, application rounds and emails.
export default function SettingsPage() {
  const user = useUser();
  const router = useRouter();
  const [tab, setTab] = useState("general");

  useEffect(() => {
    if (user.role !== "admin") router.replace("/dashboard");
  }, [user.role, router]);

  // Keep the open tab in the URL hash, so a reload (after a colour change)
  // lands on the same tab.
  useEffect(() => {
    const hash = window.location.hash.replace("#", "");
    if (TABS.includes(hash)) setTab(hash);
  }, []);

  function changeTab(next) {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  if (user.role !== "admin") return null;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        title="Settings"
        description="Only admins can see this page."
      />
      <Tabs value={tab} onValueChange={changeTab} className="gap-6">
        <TabsList variant="line" className="max-w-full overflow-x-auto">
          <TabsTrigger value="general" className="px-3">
            General
          </TabsTrigger>
          <TabsTrigger value="branding" className="px-3">
            Branding
          </TabsTrigger>
          <TabsTrigger value="applications" className="px-3">
            Applications
          </TabsTrigger>
          <TabsTrigger value="email" className="px-3">
            Email
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="space-y-4">
          <AuthSettings />
          <FeatureSwitches />
          <TeamSettings />
          <OrganizerRoomSettings />
          <CheckInPopupSettings />
        </TabsContent>
        <TabsContent value="branding" className="space-y-4">
          <BrandingCard />
        </TabsContent>
        <TabsContent value="applications" className="space-y-4">
          <ReviewSettings />
          <AutoAcceptSettings />
          <RoundsManager />
        </TabsContent>
        <TabsContent value="email" className="space-y-4">
          <EmailTemplateEditor />
        </TabsContent>
      </Tabs>
    </div>
  );
}
