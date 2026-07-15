import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function MarketingPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Belanja", value: "RM18.4k" }, { label: "Lead", value: "326" }, { label: "CPL", value: "RM56.44" }]}
    title="Kempen"
    columns={[{ key: "campaign", label: "Kempen" }, { key: "channel", label: "Saluran" }, { key: "leads", label: "Lead" }, { key: "spend", label: "Belanja", align: "right" }]}
    rows={[
      { id: "c1", campaign: "Salam Land Julai", channel: "Meta", leads: "184", spend: "RM10,240" },
      { id: "c2", campaign: "Lot Fasa C", channel: "TikTok", leads: "112", spend: "RM6,820" },
      { id: "c3", campaign: "Rujukan aktif", channel: "Rujukan", leads: "30", spend: "RM1,340" },
    ]}
  />;
}
