import {
  ArrowRight,
  CalendarClock,
  CircleDollarSign,
  ContactRound,
  WalletCards,
} from "lucide-react";
import type { ProductSurface } from "@/config/product-surface";
import { demoActivities, demoTasks } from "@/lib/demo-crm";
import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui";
import { DataEmptyState } from "./data-empty-state";
import { MetricCard, MetricGrid } from "./metric";

export function SurfaceHome({
  demo,
  surface,
}: {
  demo: boolean;
  surface: ProductSurface;
}) {
  if (surface === "tasha") {
    return <DataEmptyState label="Data pengecualian belum tersedia." />;
  }

  if (!demo) {
    return <DataEmptyState label="Belum ada data." />;
  }

  return (
    <div className="crm-page-stack">
      <MetricGrid>
        <MetricCard label="Lead baharu" value="42" delta="12.5%" trend="positive" context="30 hari" icon={ContactRound} />
        <MetricCard label="Susulan lewat" value="7" delta="3" trend="negative" context="perlu tindakan" icon={CalendarClock} />
        <MetricCard label="Nilai pipeline" value="RM1.24j" delta="8.2%" trend="positive" context="aktif" icon={CircleDollarSign} />
        <MetricCard label="Kutipan" value="RM286k" delta="RM34k" trend="positive" context="bulan ini" icon={WalletCards} />
      </MetricGrid>

      <div className="crm-dashboard-grid">
        <Card>
          <CardHeader>
            <CardTitle>Hari ini</CardTitle>
            <a href="/tasks" className="crm-text-link">Semua <ArrowRight aria-hidden="true" /></a>
          </CardHeader>
          <CardContent className="crm-list-flush">
            <ul className="crm-task-list">
              {demoTasks.map((task) => (
                <li key={task.id} className="crm-task-row">
                  <span className="crm-task-row__marker" data-priority={task.priority} aria-hidden="true" />
                  <span className="crm-task-row__copy">
                    <strong>{task.title}</strong>
                    <span>{task.meta}</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Pipeline</CardTitle><Badge variant="success">34 aktif</Badge></CardHeader>
          <CardContent>
            <div className="crm-funnel-list">
              {[
                ["Kelayakan", 14, 100],
                ["Tawaran", 9, 64],
                ["Rundingan", 7, 50],
                ["Menang", 4, 29],
              ].map(([label, count, width]) => (
                <div className="crm-funnel-row" key={String(label)}>
                  <div className="crm-funnel-row__label"><span>{label}</span><strong>{count}</strong></div>
                  <div className="crm-progress" role="progressbar" aria-label={`${label}: ${count}`} aria-valuenow={Number(width)} aria-valuemin={0} aria-valuemax={100}>
                    <span data-width={width} />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Aktiviti terkini</CardTitle></CardHeader>
        <CardContent className="crm-card-content--flush">
          <Table responsive="stack">
            <TableHeader><TableRow><TableHead>Tindakan</TableHead><TableHead>Rekod</TableHead><TableHead>Oleh</TableHead><TableHead align="right">Masa</TableHead></TableRow></TableHeader>
            <TableBody>
              {demoActivities.map((activity) => (
                <TableRow key={activity.id}>
                  <TableCell label="Tindakan"><strong>{activity.action}</strong></TableCell>
                  <TableCell label="Rekod">{activity.record}</TableCell>
                  <TableCell label="Oleh">{activity.actor}</TableCell>
                  <TableCell label="Masa" align="right">{activity.time}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
