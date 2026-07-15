import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function TasksPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Hari ini", value: "12" }, { label: "Lewat", value: "7" }, { label: "Selesai", value: "34" }]}
    title="Senarai tugasan"
    columns={[{ key: "task", label: "Tugasan" }, { key: "record", label: "Rekod" }, { key: "owner", label: "Pemilik" }, { key: "due", label: "Tarikh" }]}
    rows={[
      { id: "t1", task: "Hubungi pelanggan", record: "Nur Aisyah", owner: "Farah", due: "Hari ini, 2:30 PTG" },
      { id: "t2", task: "Semak bukti bayaran", record: "SL-2026-0481", owner: "Amir", due: "Hari ini, 3:15 PTG" },
      { id: "t3", task: "Tamatkan pegangan", record: "Lot A-109", owner: "Nadia", due: "Hari ini, 4:45 PTG" },
    ]}
  />;
}
