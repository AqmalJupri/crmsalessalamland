"use client";

import { useMemo, useRef, useState, type FormEvent } from "react";
import { Plus, Search, X } from "lucide-react";
import { Badge, Button, Input, Select, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { normalizeMalaysianPhone } from "@/domain/contacts/identity";
import type { ClientBusinessScope } from "@/domain/business-units/client-scope";
import { filterDemoRecordsByUnitIds, getLeadStageFilterOptions, getLeadStagePresentation, getProviderLabel, leadProviderOptions, type DemoLead } from "@/lib/demo-crm";
import { DataEmptyState } from "./data-empty-state";
import { UnsavedChangesDialog } from "./unsaved-changes-dialog";
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

interface LeadApiBody {
  data?: ApiCreatedLead;
  error?: { message?: unknown; details?: unknown };
}

type LeadFormField = "name" | "phone" | "source" | "productInterest";
type LeadFieldErrors = Partial<Record<LeadFormField, string>>;

const leadFormFieldOrder: readonly LeadFormField[] = [
  "name",
  "phone",
  "source",
  "productInterest",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLeadApiBody(response: Response): Promise<LeadApiBody> {
  try {
    const body: unknown = await response.json();
    return isRecord(body) ? body as LeadApiBody : {};
  } catch {
    return {};
  }
}

function apiValidationErrors(value: unknown): {
  fields: LeadFieldErrors;
  hasUnassigned: boolean;
} {
  if (!isRecord(value) || !isRecord(value.details) || !isRecord(value.details.fields)) {
    return { fields: {}, hasUnassigned: false };
  }

  const fields: LeadFieldErrors = {};
  let hasUnassigned = false;
  for (const [name, messages] of Object.entries(value.details.fields)) {
    const message = Array.isArray(messages)
      ? messages.find((item): item is string => typeof item === "string" && item.trim().length > 0)
      : typeof messages === "string" && messages.trim().length > 0
        ? messages
        : undefined;
    if (!message) continue;
    if (leadFormFieldOrder.includes(name as LeadFormField)) {
      fields[name as LeadFormField] ??= message;
    } else {
      hasUnassigned = true;
    }
  }
  return { fields, hasUnassigned };
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
  const [discardOpen, setDiscardOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<LeadFieldErrors>({});
  const [formError, setFormError] = useState("");
  const [status, setStatus] = useState("");
  const idempotencyKeyRef = useRef<string | null>(null);
  const detailDialogRef = useRef<HTMLElement>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  const createDialogRef = useRef<HTMLFormElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLSelectElement>(null);
  const productInterestInputRef = useRef<HTMLInputElement>(null);

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
    initialFocusRef: nameInputRef,
    onClose: requestCloseCreate,
    open: createOpen,
    paused: discardOpen,
  });

  function closeCreate(): void {
    setCreateOpen(false);
    setDiscardOpen(false);
    setDirty(false);
    setFieldErrors({});
    setFormError("");
    idempotencyKeyRef.current = null;
  }

  function requestCloseCreate(): void {
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    closeCreate();
  }

  function markFormDirty(event: FormEvent<HTMLFormElement>): void {
    setDirty(true);
    idempotencyKeyRef.current = null;
    const target = event.target;
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) &&
      leadFormFieldOrder.includes(target.name as LeadFormField)
    ) {
      const name = target.name as LeadFormField;
      setFieldErrors((current) => {
        if (!current[name]) return current;
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
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

    setFieldErrors({});
    setFormError("");
    let phone: string;
    try {
      phone = normalizeMalaysianPhone(phoneRaw);
    } catch (error) {
      setFieldErrors({
        phone: error instanceof Error
          ? error.message
          : "Masukkan nombor mudah alih Malaysia yang sah.",
      });
      phoneInputRef.current?.focus();
      return;
    }

    try {
      setSaving(true);
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
      const body = await readLeadApiBody(response);
      if (!response.ok) {
        const validation = apiValidationErrors(body.error);
        const firstInvalid = leadFormFieldOrder.find((name) => validation.fields[name]);
        if (firstInvalid) {
          setFieldErrors(validation.fields);
          setFormError(
            validation.hasUnassigned && typeof body.error?.message === "string"
              ? body.error.message
              : "",
          );
          const controls = {
            name: nameInputRef,
            phone: phoneInputRef,
            source: sourceInputRef,
            productInterest: productInterestInputRef,
          } as const;
          controls[firstInvalid].current?.focus();
          return;
        }
        throw new Error(
          typeof body.error?.message === "string" && body.error.message.trim()
            ? body.error.message
            : "Lead tidak dapat disimpan.",
        );
      }
      if (!body.data) throw new Error("Lead tidak dapat disimpan.");

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
      closeCreate();
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
        <section className="crm-record-section">
          <Table responsive="stack" containerLabel="Senarai lead">
            <TableCaption>Senarai lead</TableCaption>
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
        </section>
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
        <div className="crm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) requestCloseCreate(); }}>
          <form ref={createDialogRef} className="crm-modal" role="dialog" aria-modal="true" aria-labelledby="new-lead-title" tabIndex={-1} onSubmit={submitLead} onChange={markFormDirty} inert={discardOpen || undefined} aria-hidden={discardOpen || undefined}>
            <header className="crm-modal__header"><h2 id="new-lead-title">Lead baharu</h2><Button size="icon" variant="quiet" aria-label="Tutup" onClick={requestCloseCreate}><X aria-hidden="true" /></Button></header>
            <div className="crm-modal__body">
              <Input ref={nameInputRef} name="name" label="Nama" autoComplete="name" required minLength={2} maxLength={160} error={fieldErrors.name} containerClassName="crm-modal__field-wide" />
              <Input ref={phoneInputRef} name="phone" type="tel" label="Telefon" inputMode="tel" autoComplete="tel" required placeholder="0123456789" error={fieldErrors.phone} />
              <Select ref={sourceInputRef} name="source" label="Sumber" required defaultValue="meta" error={fieldErrors.source}>{leadProviderOptions.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}</Select>
              <Input ref={productInterestInputRef} name="productInterest" label="Minat produk" required minLength={2} maxLength={200} error={fieldErrors.productInterest} containerClassName="crm-modal__field-wide" />
            </div>
            {formError ? <p className="crm-live-status crm-form-error" role="alert">{formError}</p> : null}
            <footer className="crm-modal__footer"><Button onClick={requestCloseCreate}>Batal</Button><Button type="submit" variant="primary" loading={saving} loadingLabel="Menyimpan">Simpan</Button></footer>
          </form>
        </div>
      ) : null}

      <UnsavedChangesDialog
        formName="Lead baharu"
        open={discardOpen}
        onCancel={() => setDiscardOpen(false)}
        onDiscard={closeCreate}
      />
    </div>
  );
}
