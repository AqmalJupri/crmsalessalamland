import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function TeamPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Aktif", value: "18" }, { label: "Sasaran dicapai", value: "7" }, { label: "Susulan lewat", value: "7" }]}
    title="Pasukan jualan"
    columns={[{ key: "name", label: "Nama" }, { key: "role", label: "Peranan" }, { key: "pipeline", label: "Pipeline" }, { key: "won", label: "Menang", align: "right" }]}
    rows={[
      { id: "u1", name: "Farah", role: "Eksekutif Jualan", pipeline: "RM512k", won: "RM210k" },
      { id: "u2", name: "Amir", role: "Eksekutif Jualan", pipeline: "RM426k", won: "RM168k" },
      { id: "u3", name: "Nadia", role: "Pengurus Jualan", pipeline: "RM398k", won: "RM352k" },
    ]}
  />;
}
