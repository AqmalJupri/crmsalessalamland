import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function OrdersPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Aktif", value: "28" }, { label: "Menunggu", value: "6" }, { label: "Nilai", value: "RM842k" }]}
    title="Pesanan terkini"
    columns={[{ key: "order", label: "Pesanan" }, { key: "customer", label: "Pelanggan" }, { key: "state", label: "Status" }, { key: "value", label: "Nilai", align: "right" }]}
    rows={[
      { id: "o1", order: "SL-2026-0481", customer: "Daniel Wong", state: "Disahkan", value: "RM210,000" },
      { id: "o2", order: "SL-2026-0480", customer: "Nur Aisyah", state: "Draf", value: "RM185,000" },
      { id: "o3", order: "SL-2026-0479", customer: "Hakim Razak", state: "Menunggu", value: "RM168,000" },
    ]}
  />;
}
