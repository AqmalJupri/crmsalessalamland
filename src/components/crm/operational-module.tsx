import { Badge, Card, CardContent, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";

export interface ModuleMetric {
  label: string;
  value: string;
}

export interface ModuleColumn {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
}

export interface ModuleRow {
  id: string;
  [key: string]: string;
}

export function OperationalModule({
  metrics,
  title,
  columns,
  rows,
}: {
  metrics: readonly ModuleMetric[];
  title: string;
  columns: readonly ModuleColumn[];
  rows: readonly ModuleRow[];
}) {
  return (
    <div className="crm-page-stack">
      <div className="crm-module-grid">
        {metrics.map((metric) => <article className="crm-module-stat" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></article>)}
      </div>
      <Card>
        <CardHeader><CardTitle>{title}</CardTitle><Badge variant="neutral">{rows.length}</Badge></CardHeader>
        <CardContent className="crm-card-content--flush">
          <Table responsive="stack">
            <TableHeader><TableRow>{columns.map((column) => <TableHead key={column.key} {...(column.align ? { align: column.align } : {})}>{column.label}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {rows.map((row) => <TableRow key={row.id}>{columns.map((column) => <TableCell key={column.key} label={column.label} {...(column.align ? { align: column.align } : {})}>{row[column.key] ?? "—"}</TableCell>)}</TableRow>)}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
