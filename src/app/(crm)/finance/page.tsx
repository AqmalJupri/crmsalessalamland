import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function FinancePage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Kutipan bulan", value: "RM286k" }, { label: "Tertunggak", value: "RM94k" }, { label: "Belum agih", value: "RM8k" }]}
    title="Transaksi terkini"
    columns={[{ key: "receipt", label: "Resit" }, { key: "order", label: "Pesanan" }, { key: "state", label: "Status" }, { key: "amount", label: "Amaun", align: "right" }]}
    rows={[
      { id: "p1", receipt: "RC-2026-1208", order: "SL-2026-0481", state: "Diagih", amount: "RM12,500" },
      { id: "p2", receipt: "RC-2026-1207", order: "SL-2026-0477", state: "Sebahagian", amount: "RM8,000" },
      { id: "p3", receipt: "RC-2026-1206", order: "SL-2026-0472", state: "Diagih", amount: "RM18,500" },
    ]}
  />;
}
