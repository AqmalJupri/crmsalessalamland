import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ApplicationShell } from "@/components/crm/application-shell";
import {
  isProductPathAvailable,
  PRODUCT_REQUEST_PATH_HEADER,
} from "@/config/product-navigation";
import { getViewer } from "@/server/auth/viewer";
import { projectPublicViewer } from "@/domain/auth/public-viewer";
import { getRuntimeConfig } from "@/server/env";

export const dynamic = "force-dynamic";

export default async function CrmLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const surface = getRuntimeConfig().productSurface;
  const requestPath = (await headers()).get(PRODUCT_REQUEST_PATH_HEADER);
  if (!requestPath || !isProductPathAvailable(surface, requestPath)) {
    notFound();
  }

  const viewer = await getViewer();
  if (!viewer) return children;

  return (
    <ApplicationShell
      surface={surface}
      viewer={projectPublicViewer(viewer, surface)}
    >
      {children}
    </ApplicationShell>
  );
}
