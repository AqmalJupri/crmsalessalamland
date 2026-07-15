import type { Metadata } from "next";
import { LeadsWorkspace } from "@/components/crm/leads-workspace";
import { demoLeads } from "@/lib/demo-crm";
import { requireViewer } from "@/server/auth/viewer";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadsPage() {
  const viewer = await requireViewer("/leads");
  return (
    <LeadsWorkspace
      businessUnitId={viewer.businessUnitId}
      canCreate={viewer.capabilities.includes("lead.create")}
      initialLeads={viewer.demo ? demoLeads : []}
    />
  );
}
