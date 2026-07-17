import { useId, type ReactNode } from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Clock3,
  GitCompareArrows,
  Inbox,
  ListOrdered,
  LoaderCircle,
  RefreshCw,
  SearchX,
  ShieldX,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { cn } from "./utils";

export const OPERATION_STATE_KINDS = [
  "loading",
  "empty",
  "filtered-empty",
  "stale",
  "syncing",
  "queued",
  "partial",
  "success",
  "failed",
  "conflict",
  "offline",
  "forbidden",
  "unknown",
] as const;

export type OperationStateKind = (typeof OPERATION_STATE_KINDS)[number];

type OperationStateRole = "status" | "alert" | undefined;
type OperationStateTone = "neutral" | "action" | "warning" | "success" | "danger";

interface OperationStateDefinition {
  details?: string;
  Icon: LucideIcon;
  iconName: string;
  label: string;
  role: OperationStateRole;
  tone: OperationStateTone;
}

const definitions: Readonly<Record<OperationStateKind, OperationStateDefinition>> = {
  loading: { Icon: LoaderCircle, iconName: "loader-circle", label: "Memuat data", role: "status", tone: "action" },
  empty: { Icon: Inbox, iconName: "inbox", label: "Belum ada rekod", role: undefined, tone: "neutral" },
  "filtered-empty": { Icon: SearchX, iconName: "search-x", label: "Tiada padanan", role: undefined, tone: "neutral" },
  stale: { Icon: Clock3, iconName: "clock-3", label: "Data lewat", role: undefined, tone: "warning" },
  syncing: { Icon: RefreshCw, iconName: "refresh-cw", label: "Menyegerak data", role: "status", tone: "action" },
  queued: { Icon: ListOrdered, iconName: "list-ordered", label: "Dalam giliran", role: "status", tone: "action" },
  partial: { Icon: CircleDashed, iconName: "circle-dashed", label: "Sebahagian selesai", role: "status", tone: "warning" },
  success: { Icon: CircleCheck, iconName: "circle-check", label: "Tindakan selesai", role: "status", tone: "success" },
  failed: {
    Icon: CircleX,
    iconName: "circle-x",
    label: "Tindakan gagal",
    details: "Sistem mengesahkan permintaan berakhir dengan kegagalan. Semak rekod atau kesan tindakan terkini sebelum cuba semula.",
    role: "alert",
    tone: "danger",
  },
  conflict: {
    Icon: GitCompareArrows,
    iconName: "git-compare-arrows",
    label: "Perubahan bertindih",
    details: "Sistem mengesan versi rekod berbeza. Muat semula dan semak perubahan sebelum menyimpan semula.",
    role: "alert",
    tone: "danger",
  },
  offline: {
    Icon: WifiOff,
    iconName: "wifi-off",
    label: "Di luar talian",
    details: "Keputusan tindakan belum dapat disahkan kerana sambungan terputus. Selepas talian pulih, semak rekod atau status terkini sebelum cuba semula.",
    role: "alert",
    tone: "danger",
  },
  forbidden: {
    Icon: ShieldX,
    iconName: "shield-x",
    label: "Akses ditolak",
    details: "Tindakan disekat kerana akses tidak dibenarkan. Hubungi pentadbir jika akses diperlukan.",
    role: "alert",
    tone: "danger",
  },
  unknown: {
    Icon: CircleHelp,
    iconName: "circle-help",
    label: "Status tidak diketahui",
    details: "Keputusan tindakan belum dapat dipastikan. Semak status terkini sebelum mengambil tindakan seterusnya.",
    role: undefined,
    tone: "neutral",
  },
};

export interface OperationStateProps {
  action?: ReactNode;
  className?: string;
  details?: ReactNode;
  kind: OperationStateKind;
  label?: ReactNode;
}

export function OperationState({
  action,
  className,
  details,
  kind,
  label,
}: OperationStateProps) {
  const labelId = useId();
  const definition = definitions[kind];
  const { Icon } = definition;
  const polite = definition.role === "status";
  const renderedDetails = details ?? definition.details;

  return (
    <section
      className={cn("crm-operation-state", className)}
      data-state-kind={kind}
      data-state-tone={definition.tone}
      role={definition.role}
      aria-labelledby={labelId}
      aria-live={polite ? "polite" : undefined}
      aria-atomic={polite ? "true" : undefined}
    >
      <Icon
        aria-hidden="true"
        focusable="false"
        data-state-icon={definition.iconName}
      />
      <strong id={labelId}>{label ?? definition.label}</strong>
      {renderedDetails ? (
        <div className="crm-operation-state__details">{renderedDetails}</div>
      ) : null}
      {action ? <div className="crm-operation-state__action">{action}</div> : null}
    </section>
  );
}
