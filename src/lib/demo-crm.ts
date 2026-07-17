export type DemoLeadStage =
  | "new"
  | "assigned"
  | "contacted"
  | "qualified"
  | "nurture"
  | "disqualified"
  | "converted";

export interface DemoBusinessContext {
  businessUnitId: string;
  businessUnitCode: string;
  businessUnitName: string;
}

export const demoBusinessUnits = {
  salam: {
    businessUnitId: "00000000-0000-4000-8000-000000000101",
    businessUnitCode: "salam-land",
    businessUnitName: "Salam Land",
  },
  bumi: {
    businessUnitId: "00000000-0000-4000-8000-000000000102",
    businessUnitCode: "bumi-hayat",
    businessUnitName: "Bumi Hayat Printing",
  },
  barakah: {
    businessUnitId: "00000000-0000-4000-8000-000000000103",
    businessUnitCode: "barakah-emas",
    businessUnitName: "Barakah Emas",
  },
} as const satisfies Record<string, DemoBusinessContext>;

export interface DemoLead extends DemoBusinessContext {
  id: string;
  name: string;
  phone: string;
  source: string;
  productInterest: string;
  owner: string;
  stage: string;
  nextAction: string;
  version: number;
}

export const leadProviderOptions = [
  { value: "meta", label: "Meta" },
  { value: "tiktok", label: "TikTok" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "website", label: "Laman web" },
  { value: "referral", label: "Rujukan" },
  { value: "walk_in", label: "Datang terus" },
] as const;

const providerLabels = new Map<string, string>(
  leadProviderOptions.map((provider) => [provider.value, provider.label]),
);

const providerKeyPattern = /^[a-z][a-z0-9._-]{1,79}$/;
const stageCodePattern = /^[a-z][a-z0-9-]{1,62}$/;

function readableCode(code: string, pattern: RegExp, fallback: string): string {
  if (!pattern.test(code)) return fallback;
  const words = code.replace(/[._-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function getProviderLabel(providerKey: string): string {
  return providerLabels.get(providerKey) ?? readableCode(providerKey, providerKeyPattern, "Sumber lain");
}

export const demoLeads: DemoLead[] = [
  {
    ...demoBusinessUnits.salam,
    id: "10000000-0000-4000-8000-000000000001",
    name: "Nur Aisyah",
    phone: "+6012•••6789",
    source: "meta",
    productInterest: "Lot A-118",
    owner: "Farah",
    stage: "converted",
    nextAction: "Selesai",
    version: 4,
  },
  {
    ...demoBusinessUnits.salam,
    id: "10000000-0000-4000-8000-000000000002",
    name: "Hakim Razak",
    phone: "+6017•••4421",
    source: "tiktok",
    productInterest: "Lot B-204",
    owner: "Amir",
    stage: "converted",
    nextAction: "Selesai",
    version: 2,
  },
  {
    ...demoBusinessUnits.salam,
    id: "10000000-0000-4000-8000-000000000003",
    name: "Siti Maryam",
    phone: "+6011•••0098",
    source: "whatsapp",
    productInterest: "Lot C-031",
    owner: "Farah",
    stage: "converted",
    nextAction: "Selesai",
    version: 2,
  },
  {
    ...demoBusinessUnits.salam,
    id: "10000000-0000-4000-8000-000000000004",
    name: "Faizal Ahmad",
    phone: "+6013•••7752",
    source: "referral",
    productInterest: "Lot A-121",
    owner: "Nadia",
    stage: "converted",
    nextAction: "Selesai",
    version: 6,
  },
  {
    ...demoBusinessUnits.bumi,
    id: "10000000-0000-4000-8000-000000000005",
    name: "Izzati Salleh",
    phone: "+6019•••1330",
    source: "meta",
    productInterest: "Lot B-208",
    owner: "Amir",
    stage: "new",
    nextAction: "Hari ini, 5:00 PTG",
    version: 1,
  },
  {
    ...demoBusinessUnits.bumi,
    id: "10000000-0000-4000-8000-000000000006",
    name: "Daniel Wong",
    phone: "+6016•••8054",
    source: "website",
    productInterest: "Lot C-036",
    owner: "Nadia",
    stage: "converted",
    nextAction: "Selesai",
    version: 8,
  },
  {
    ...demoBusinessUnits.barakah,
    id: "10000000-0000-4000-8000-000000000007",
    name: "Aina Sofea",
    phone: "+6018•••2901",
    source: "tiktok",
    productInterest: "Lot A-127",
    owner: "Farah",
    stage: "converted",
    nextAction: "Selesai",
    version: 3,
  },
  {
    ...demoBusinessUnits.barakah,
    id: "10000000-0000-4000-8000-000000000008",
    name: "Azlan Omar",
    phone: "+6014•••6017",
    source: "walk_in",
    productInterest: "Lot B-211",
    owner: "Amir",
    stage: "disqualified",
    nextAction: "Selesai",
    version: 5,
  },
];

export const stageLabels: Record<DemoLeadStage, string> = {
  new: "Baharu",
  assigned: "Ditugaskan",
  contacted: "Dihubungi",
  qualified: "Layak",
  nurture: "Susulan",
  disqualified: "Tidak layak",
  converted: "Ditukar",
};

const stageVariants: Record<DemoLeadStage, "neutral" | "success" | "danger" | "info"> = {
  new: "info",
  assigned: "neutral",
  contacted: "info",
  qualified: "success",
  nurture: "neutral",
  disqualified: "danger",
  converted: "success",
};

function isKnownLeadStage(stage: string): stage is DemoLeadStage {
  return Object.prototype.hasOwnProperty.call(stageLabels, stage);
}

export function getLeadStagePresentation(stage: string): {
  label: string;
  variant: "neutral" | "success" | "danger" | "info";
} {
  if (isKnownLeadStage(stage)) {
    return { label: stageLabels[stage], variant: stageVariants[stage] };
  }
  return { label: readableCode(stage, stageCodePattern, "Status lain"), variant: "neutral" };
}

export function getLeadStageFilterOptions(leads: readonly { stage: string }[]): Array<{
  value: string;
  label: string;
}> {
  return [...new Set(leads.map((lead) => lead.stage))]
    .map((value) => ({ value, label: getLeadStagePresentation(value).label }))
    .sort((left, right) => left.label.localeCompare(right.label, "ms"));
}

export const demoTasks = [
  { ...demoBusinessUnits.salam, id: "t1", title: "Hubungi Nur Aisyah", meta: "2:30 PTG · Farah", priority: "high", status: "overdue" },
  { ...demoBusinessUnits.bumi, id: "t2", title: "Semak bukti bayaran B-204", meta: "3:15 PTG · Amir", priority: "normal", status: "due" },
  { ...demoBusinessUnits.barakah, id: "t3", title: "Tamatkan pegangan A-109", meta: "4:45 PTG · Nadia", priority: "high", status: "overdue" },
  { ...demoBusinessUnits.salam, id: "t4", title: "Hantar sebut harga Lot C-031", meta: "Esok · Farah", priority: "normal", status: "upcoming" },
] as const;

export function isDemoTaskActionableToday(task: {
  status: string | number | undefined;
}): boolean {
  return task.status === "due" || task.status === "overdue";
}

export const demoFinanceReceipts = [
  { ...demoBusinessUnits.salam, id: "p1", receipt: "RC-2026-1208", order: "SL-2026-0481", state: "Diagih", amount: "RM12,500", amountMinor: 1_250_000 },
  { ...demoBusinessUnits.bumi, id: "p2", receipt: "RC-2026-1207", order: "BH-2026-0477", state: "Sebahagian", amount: "RM8,000", amountMinor: 800_000 },
  { ...demoBusinessUnits.barakah, id: "p3", receipt: "RC-2026-1206", order: "BE-2026-0472", state: "Diagih", amount: "RM18,500", amountMinor: 1_850_000 },
] as const;

export const demoActivities = [
  { ...demoBusinessUnits.bumi, id: "a1", action: "Lead ditukar", record: "Daniel Wong · Lot C-036", actor: "Nadia", time: "12 min" },
  { ...demoBusinessUnits.salam, id: "a2", action: "Bayaran diterima", record: "SL-2026-0481 · RM12,500", actor: "Kewangan", time: "28 min" },
  { ...demoBusinessUnits.barakah, id: "a3", action: "Pegangan dibuat", record: "Lot A-118 · 24 jam", actor: "Farah", time: "41 min" },
  { ...demoBusinessUnits.bumi, id: "a4", action: "Lead masuk", record: "Izzati Salleh · Meta", actor: "Sistem", time: "1 jam" },
] as const;

export interface DemoKpi extends DemoBusinessContext {
  leadNewCount: number;
  overdueTaskCount: number;
  pipelineValueMinor: number;
  collectionMinor: number;
}

export const demoKpis: readonly DemoKpi[] = [
  {
    ...demoBusinessUnits.salam,
    leadNewCount: 0,
    overdueTaskCount: 1,
    pipelineValueMinor: 69_500_000,
    collectionMinor: 1_250_000,
  },
  {
    ...demoBusinessUnits.bumi,
    leadNewCount: 1,
    overdueTaskCount: 0,
    pipelineValueMinor: 18_800_000,
    collectionMinor: 800_000,
  },
  {
    ...demoBusinessUnits.barakah,
    leadNewCount: 0,
    overdueTaskCount: 1,
    pipelineValueMinor: 38_600_000,
    collectionMinor: 1_850_000,
  },
] as const;

export interface DemoKpiTotals {
  leadNewCount: number;
  overdueTaskCount: number;
  pipelineValueMinor: number;
  collectionMinor: number;
}

export function aggregateDemoKpiInputs(
  inputs: readonly DemoKpi[],
  unitIds: readonly string[],
): DemoKpiTotals {
  const allowed = new Set(unitIds);
  const seen = new Set<string>();
  const totals: DemoKpiTotals = {
    leadNewCount: 0,
    overdueTaskCount: 0,
    pipelineValueMinor: 0,
    collectionMinor: 0,
  };

  for (const input of inputs) {
    if (seen.has(input.businessUnitId)) {
      throw new Error("Demo KPI inputs must be unique per business unit.");
    }
    seen.add(input.businessUnitId);
    if (!allowed.has(input.businessUnitId)) continue;
    totals.leadNewCount += input.leadNewCount;
    totals.overdueTaskCount += input.overdueTaskCount;
    totals.pipelineValueMinor += input.pipelineValueMinor;
    totals.collectionMinor += input.collectionMinor;
  }
  return totals;
}

export interface DemoOpportunity extends DemoBusinessContext {
  id: string;
  title: string;
  meta: string;
  valueMinor: number;
  owner: string;
  originLeadId?: string;
}

export interface DemoOpportunityStage {
  id: string;
  title: string;
  tone?: "success" | "danger";
  items: DemoOpportunity[];
}

export function isActiveDemoOpportunityStage(stage: { id: string }): boolean {
  return stage.id !== "won";
}

export const opportunityStages: DemoOpportunityStage[] = [
  {
    id: "qualification",
    title: "Kelayakan",
    items: [
      { ...demoBusinessUnits.salam, id: "o1", title: "Nur Aisyah", meta: "Lot A-118", valueMinor: 18_500_000, owner: "Farah", originLeadId: "10000000-0000-4000-8000-000000000001" },
      { ...demoBusinessUnits.salam, id: "o2", title: "Siti Maryam", meta: "Lot C-031", valueMinor: 15_200_000, owner: "Farah", originLeadId: "10000000-0000-4000-8000-000000000003" },
      { ...demoBusinessUnits.salam, id: "o3", title: "Hakim Razak", meta: "Lot B-204", valueMinor: 16_800_000, owner: "Amir", originLeadId: "10000000-0000-4000-8000-000000000002" },
    ],
  },
  {
    id: "proposal",
    title: "Tawaran",
    items: [
      { ...demoBusinessUnits.barakah, id: "o4", title: "Aina Sofea", meta: "Lot A-127", valueMinor: 17_600_000, owner: "Farah", originLeadId: "10000000-0000-4000-8000-000000000007" },
      { ...demoBusinessUnits.salam, id: "o5", title: "Faizal Ahmad", meta: "Lot A-121", valueMinor: 19_000_000, owner: "Nadia", originLeadId: "10000000-0000-4000-8000-000000000004" },
    ],
  },
  {
    id: "negotiation",
    title: "Rundingan",
    items: [
      { ...demoBusinessUnits.bumi, id: "o6", title: "Liyana Musa", meta: "Lot B-219", valueMinor: 18_800_000, owner: "Amir" },
      { ...demoBusinessUnits.barakah, id: "o7", title: "Kumar Ravi", meta: "Lot C-044", valueMinor: 21_000_000, owner: "Nadia" },
    ],
  },
  {
    id: "won",
    title: "Menang",
    tone: "success",
    items: [
      { ...demoBusinessUnits.bumi, id: "o8", title: "Daniel Wong", meta: "Lot C-036", valueMinor: 21_000_000, owner: "Nadia", originLeadId: "10000000-0000-4000-8000-000000000006" },
    ],
  },
] ;

export function opportunityStageTotalMinor(items: readonly { valueMinor: number }[]): number {
  return items.reduce((total, item) => total + item.valueMinor, 0);
}

export function filterDemoRecordsByUnitIds<T extends DemoBusinessContext>(
  records: readonly T[],
  unitIds: readonly string[],
): T[] {
  const allowed = new Set(unitIds);
  return records.filter((record) => allowed.has(record.businessUnitId));
}

export function filterOpportunityStagesByUnitIds(
  stages: readonly DemoOpportunityStage[],
  unitIds: readonly string[],
): DemoOpportunityStage[] {
  return stages.map((stage) => ({
    ...stage,
    items: filterDemoRecordsByUnitIds(stage.items, unitIds),
  }));
}

export function formatMoneyMinor(valueMinor: number, compact = false): string {
  return new Intl.NumberFormat("ms-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 0,
    maximumFractionDigits: compact ? 2 : 0,
    notation: compact ? "compact" : "standard",
  }).format(valueMinor / 100);
}
