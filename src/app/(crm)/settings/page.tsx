import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function SettingsPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Integrasi sihat", value: "3" }, { label: "Perlu tindakan", value: "1" }, { label: "Webhook 24j", value: "326" }]}
    title="Integrasi"
    columns={[{ key: "provider", label: "Penyedia" }, { key: "state", label: "Status" }, { key: "checked", label: "Diperiksa" }, { key: "owner", label: "Pemilik" }]}
    rows={[
      { id: "i1", provider: "Meta Lead Ads", state: "Sihat", checked: "2 min", owner: "Pemasaran" },
      { id: "i2", provider: "TikTok Lead Gen", state: "Sihat", checked: "4 min", owner: "Pemasaran" },
      { id: "i3", provider: "WhatsApp Cloud", state: "Perlu semak", checked: "18 min", owner: "Operasi" },
    ]}
  />;
}
