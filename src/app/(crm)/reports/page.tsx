import { DataEmptyState } from "@/components/crm/data-empty-state";
import { OperationalModule } from "@/components/crm/operational-module";
import { canRenderDemoFixtures } from "@/server/auth/page-access";

export default function ReportsPage() {
  if (!canRenderDemoFixtures()) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return <OperationalModule
    metrics={[{ label: "Kadar menang", value: "24.8%" }, { label: "Masa tutup", value: "18 hari" }, { label: "Kutipan", value: "82.4%" }]}
    title="Laporan tersimpan"
    columns={[{ key: "report", label: "Laporan" }, { key: "period", label: "Tempoh" }, { key: "owner", label: "Pemilik" }, { key: "updated", label: "Dikemas kini" }]}
    rows={[
      { id: "r1", report: "Prestasi jualan", period: "Julai 2026", owner: "Pengurusan", updated: "Hari ini" },
      { id: "r2", report: "Usia kutipan", period: "Semasa", owner: "Kewangan", updated: "1 jam" },
      { id: "r3", report: "Atribusi pemasaran", period: "30 hari", owner: "Pemasaran", updated: "3 jam" },
    ]}
  />;
}
