"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { Plus, Search, X } from "lucide-react";
import { Badge, Button, Card, CardContent, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { normalizeMalaysianPhone } from "@/domain/contacts/identity";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";
import { filterDemoRecordsByUnitIds, getLeadStageFilterOptions, getLeadStagePresentation, getProviderLabel, leadProviderOptions, type DemoLead } from "@/lib/demo-crm";
import { DataEmptyState } from "./data-empty-state";
import { useDialogFocus } from "./use-dialog-focus";

function maskPhone(phone: string): string {
  if (phone.includes("•")) return phone;
  return phone.replace(/^(\+60\d{2})\d+(\d{4})$/, "$1•••$2");
}

interface ApiCreatedLead {
  id: string;
  name: string;
  phone: string;
  stage: string;
  source: string;
  productInterest: string | null;
  version: number;
}

interface LeadsWorkspaceProps {
  scope: ClientBusinessScope;
  canCreate: boolean;
  initialLeads: DemoLead[];
  initialStageFilter?: string | null;
}

export function LeadsWorkspace(props: LeadsWorkspaceProps) {
  const scopeKey = props.scope.kind === "ALL"
    ? `ALL:${props.scope.unitIds.join("|")}`
    : `UNIT:${props.scope.businessUnitId}`;
  return <ScopedLeadsWorkspace key={`${scopeKey}:${props.initialStageFilter ?? "all"}`} {...props} />;
}

function ScopedLeadsWorkspace({
  scope,
  canCreate,
  initialLeads,
  initialStageFilter = null,
}: LeadsWorkspaceProps) {
  const unitIds = scope.kind === "ALL" ? scope.unitIds : [scope.businessUnitId];
  const [leads, setLeads] = useState(() =>
    filterDemoRecordsByUnitIds(initialLeads, unitIds),
  );
  const writeAccess = scope.kind === "UNIT" ? {
    id: scope.businessUnitId,
    code: scope.businessUnitCode,
    name: scope.businessUnitName,
  } : null;
  const createAllowed = canCreate && writeAccess !== null;
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState<string>(initialStageFilter ?? "all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [formError, setFormError] = useState("");
  const [status, setStatus] = useState("");
  const idempotencyKeyRef = useRef<string | null>(null);
  const detailDialogRef = useRef<HTMLElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const createDialogRef = useRef<HTMLFormElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  const selectedLead = leads.find((lead) => lead.id === selectedId) ?? null;
  const selectedStage = selectedLead ? getLeadStagePresentation(selectedLead.stage) : null;
  const dialogOpen = selectedLead !== null || createOpen;
  const stageOptions = useMemo(() => {
    const options = getLeadStageFilterOptions(leads);
    if (
      initialStageFilter &&
      !options.some((option) => option.value === initialStageFilter)
    ) {
      options.push({
        value: initialStageFilter,
        label: getLeadStagePresentation(initialStageFilter).label,
      });
      options.sort((left, right) => left.label.localeCompare(right.label, "ms"));
    }
    return options;
  }, [initialStageFilter, leads]);
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return leads.filter((lead) => {
      const matchesStage = stage === "all" || lead.stage === stage;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [lead.name, lead.phone, getProviderLabel(lead.source), lead.productInterest, lead.owner, lead.businessUnitName]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesStage && matchesQuery;
    });
  }, [leads, query, stage]);

  useDialogFocus({
    dialogRef: detailDialogRef,
    initialFocusRef: detailCloseRef,
    onClose: () => setSelectedId(null),
    open: selectedLead !== null,
  });
  useDialogFocus({
    dialogRef: createDialogRef,
    initialFocusRef: firstInputRef,
    onClose: closeCreate,
    open: createOpen,
  });

  function closeCreate(force = false): void {
    if (!force && dirty && !window.confirm("Buang perubahan yang belum disimpan?")) return;
    setCreateOpen(false);
    setDirty(false);
    setFormError("");
    idempotencyKeyRef.current = null;
  }

  function markFormDirty(): void {
    setDirty(true);
    idempotencyKeyRef.current = null;
  }

  async function submitLead(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    if (!writeAccess) {
      setFormError("Pilih syarikat.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const phoneRaw = String(form.get("phone") ?? "");
    const source = String(form.get("source") ?? "");
    const productInterest = String(form.get("productInterest") ?? "").trim();

    try {
      const phone = normalizeMalaysianPhone(phoneRaw);
      setSaving(true);
      setFormError("");
      const idempotencyKey = idempotencyKeyRef.current ?? `lead:${crypto.randomUUID()}`;
      idempotencyKeyRef.current = idempotencyKey;
      const response = await fetch("/api/v1/leads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ businessUnitId: writeAccess.id, name, phone, source, productInterest }),
      });
      const body = (await response.json()) as {
        data?: ApiCreatedLead;
        error?: { message?: string };
      };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Lead tidak dapat disimpan.");

      const created: DemoLead = {
        businessUnitId: writeAccess.id,
        businessUnitCode: writeAccess.code,
        businessUnitName: writeAccess.name,
        id: body.data.id,
        name: body.data.name,
        phone: maskPhone(body.data.phone),
        source: body.data.source,
        productInterest: body.data.productInterest ?? "Belum ditetapkan",
        owner: "Belum ditugaskan",
        stage: body.data.stage,
        nextAction: "Belum ditetapkan",
        version: body.data.version,
      };
      setLeads((current) => [created, ...current]);
      setStatus(`${created.name} ditambah.`);
      closeCreate(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Lead tidak dapat disimpan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="crm-workspace">
      <div
        className="crm-page-stack crm-workspace-background"
        inert={dialogOpen || undefined}
        aria-hidden={dialogOpen || undefined}
      >
      {leads.length > 0 || createAllowed || scope.kind === "ALL" ? (
        <div className="crm-toolbar">
        {leads.length > 0 ? (
          <div className="crm-toolbar__filters">
          <Input
            aria-label="Cari lead"
            placeholder="Cari nama, telefon, minat"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            leadingIcon={<Search />}
            containerClassName="crm-toolbar__search"
          />
          <Select
            aria-label="Tapis status"
            value={stage}
            onChange={(event) => setStage(event.target.value)}
            containerClassName="crm-toolbar__select"
          >
            <option value="all">Semua status</option>
            {stageOptions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </Select>
          </div>
        ) : <span />}
        {createAllowed ? (
          <Button variant="primary" onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" />Lead baharu</Button>
        ) : scope.kind === "ALL" ? <Button disabled>Pilih syarikat</Button> : null}
        </div>
      ) : null}

      <p className="crm-live-status" role="status" aria-live="polite">{status}</p>

      {leads.length === 0 ? (
        <DataEmptyState label="Belum ada lead." />
      ) : (
        <Card>
        <CardContent className="crm-card-content--flush">
          <Table responsive="stack">
            <TableHeader>
              <TableRow>
                <TableHead>Lead</TableHead>{scope.kind === "ALL" ? <TableHead>Syarikat</TableHead> : null}<TableHead>Status</TableHead><TableHead>Pemilik</TableHead>
                <TableHead>Tindakan seterusnya</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((lead) => {
                const leadStage = getLeadStagePresentation(lead.stage);
                return <TableRow key={lead.id}>
                  <TableCell label="Lead">
                    <div className="crm-cell-stack">
                      <button className="crm-record-link" type="button" onClick={() => setSelectedId(lead.id)}>{lead.name}</button>
                      <span>{lead.phone} · {getProviderLabel(lead.source)}</span>
                    </div>
                  </TableCell>
                  {scope.kind === "ALL" ? <TableCell label="Syarikat">{lead.businessUnitName}</TableCell> : null}
                  <TableCell label="Status"><Badge variant={leadStage.variant}>{leadStage.label}</Badge></TableCell>
                  <TableCell label="Pemilik">{lead.owner}</TableCell>
                  <TableCell label="Tindakan seterusnya">{lead.nextAction}</TableCell>
                </TableRow>
              })}
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={scope.kind === "ALL" ? 5 : 4}>Tiada rekod sepadan.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
          <div className="crm-pagination"><span>{filtered.length} daripada {leads.length}</span><span>Halaman 1</span></div>
        </CardContent>
        </Card>
      )}
      </div>

      {selectedLead ? (
        <>
          <button className="crm-detail-backdrop" type="button" aria-label="Tutup butiran lead" onClick={() => setSelectedId(null)} />
          <aside ref={detailDialogRef} className="crm-detail-panel" role="dialog" aria-modal="true" aria-labelledby="lead-detail-title" tabIndex={-1}>
            <header className="crm-detail-panel__header">
              <div><h2 id="lead-detail-title">{selectedLead.name}</h2><p>{selectedLead.phone}</p></div>
              <Button ref={detailCloseRef} size="icon" variant="quiet" aria-label="Tutup" onClick={() => setSelectedId(null)}><X aria-hidden="true" /></Button>
            </header>
            <section className="crm-detail-panel__section">
              <h3>Ringkasan</h3>
              <ul className="crm-detail-list">
                <li><span>Status</span><Badge variant={selectedStage!.variant}>{selectedStage!.label}</Badge></li>
                <li><span>Syarikat</span><strong>{selectedLead.businessUnitName}</strong></li>
                <li><span>Minat produk</span><strong>{selectedLead.productInterest}</strong></li>
                <li><span>Sumber</span><strong>{getProviderLabel(selectedLead.source)}</strong></li>
                <li><span>Pemilik</span><strong>{selectedLead.owner}</strong></li>
              </ul>
            </section>
            <section className="crm-detail-panel__section"><h3>Tindakan seterusnya</h3><strong>{selectedLead.nextAction}</strong></section>
          </aside>
        </>
      ) : null}

      {createOpen ? (
        <div className="crm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreate(); }}>
          <form ref={createDialogRef} className="crm-modal" role="dialog" aria-modal="true" aria-labelledby="new-lead-title" tabIndex={-1} onSubmit={submitLead} onChange={markFormDirty}>
            <header className="crm-modal__header"><h2 id="new-lead-title">Lead baharu</h2><Button size="icon" variant="quiet" aria-label="Tutup" onClick={() => closeCreate()}><X aria-hidden="true" /></Button></header>
            <div className="crm-modal__body">
              <Input ref={firstInputRef} name="name" label="Nama" autoComplete="name" required minLength={2} maxLength={160} containerClassName="crm-modal__field-wide" />
              <Input name="phone" type="tel" label="Telefon" inputMode="tel" autoComplete="tel" required placeholder="0123456789" />
              <Select name="source" label="Sumber" required defaultValue="meta">{leadProviderOptions.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</Select>
              <Input name="productInterest" label="Minat produk" required minLength={2} maxLength={200} containerClassName="crm-modal__field-wide" />
            </div>
            <p className="crm-live-status crm-form-error" role="alert">{formError}</p>
            <footer className="crm-modal__footer"><Button onClick={() => closeCreate()}>Batal</Button><Button type="submit" variant="primary" loading={saving} loadingLabel="Menyimpan">Simpan</Button></footer>
          </form>
        </div>
      ) : null}
    </div>
  );
}
