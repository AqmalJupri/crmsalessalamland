import { notFound } from "next/navigation";
import {
  OPERATION_STATE_KINDS,
  OperationState,
  type OperationStateKind,
  type OperationStateProps,
} from "@/components/ui/operation-state";

type GalleryEnvironment = Readonly<{
  CRM_DEMO_MODE?: string;
  DEPLOYMENT_ENVIRONMENT?: string;
  NODE_ENV?: string;
}>;

const galleryOverrides: Partial<
  Record<OperationStateKind, Pick<OperationStateProps, "details" | "label">>
> = {
  failed: {
    label: "Bayaran Pesanan SL-TEST-001 gagal",
    details: "Rujukan bank ditolak oleh sistem. Semak rekod bayaran dan rujukan bank sebelum cuba semula.",
  },
  conflict: {
    details: "Rekod berubah selepas halaman dibuka. Muat semula dan semak perubahan.",
  },
  forbidden: {
    details: "Akses tidak dibenarkan untuk syarikat ini. Hubungi pentadbir jika akses diperlukan.",
  },
};

export function canRenderOperationStateGallery(environment: GalleryEnvironment): boolean {
  return environment.CRM_DEMO_MODE === "true"
    && (environment.NODE_ENV === "development" || environment.NODE_ENV === "test")
    && (environment.DEPLOYMENT_ENVIRONMENT === "local"
      || environment.DEPLOYMENT_ENVIRONMENT === "ci");
}

export default function OperationStatesPage() {
  if (!canRenderOperationStateGallery(process.env)) notFound();

  return (
    <main className="crm-theme crm-state-gallery-page" aria-labelledby="state-gallery-title">
      <h1 id="state-gallery-title">Status operasi</h1>
      <div className="crm-state-gallery">
        {OPERATION_STATE_KINDS.map((kind) => (
          <OperationState key={kind} kind={kind} {...galleryOverrides[kind]} />
        ))}
      </div>
    </main>
  );
}
