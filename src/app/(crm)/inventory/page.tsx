import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function InventoryPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Tersedia", value: "74" }, { label: "Pegangan", value: "9" }, { label: "Ditempah", value: "31" }]}
    title="Status lot"
    columns={[{ key: "lot", label: "Lot" }, { key: "project", label: "Projek" }, { key: "state", label: "Status" }, { key: "expires", label: "Tamat pegangan" }]}
    rows={[
      { id: "l1", lot: "A-118", project: "Fasa A", state: "Pegangan", expires: "16 Jul, 3:10 PTG" },
      { id: "l2", lot: "B-204", project: "Fasa B", state: "Ditempah", expires: "—" },
      { id: "l3", lot: "C-041", project: "Fasa C", state: "Tersedia", expires: "—" },
    ]}
  />;
}
