"use client";

import HardwareLab from "@/components/HardwareLab";
import { useAcceptedOnly } from "@/lib/acceptedOnly";

// Only accepted participants (and staff) see this page; others go home.
export default function HardwarePage() {
  const allowed = useAcceptedOnly();
  return allowed ? <HardwareLab mode="attendee" /> : null;
}
