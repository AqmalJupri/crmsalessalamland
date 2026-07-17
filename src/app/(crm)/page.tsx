import { SurfaceHome } from "@/components/crm/surface-home";
import { requireScopedPageViewer } from "@/server/auth/page-access";
import { getRuntimeConfig } from "@/server/env";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ bu?: string | string[] }>;
}) {
  const query = await searchParams;
  const { viewer, scope } = await requireScopedPageViewer(
    query.bu,
    undefined,
    "/",
    query,
  );
  const surface = getRuntimeConfig().productSurface;

  return <SurfaceHome surface={surface} demo={viewer.demo} scope={scope} />;
}
