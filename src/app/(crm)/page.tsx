import { SurfaceHome } from "@/components/crm/surface-home";
import { requirePageViewer } from "@/server/auth/page-access";
import { getRuntimeConfig } from "@/server/env";

export default async function DashboardPage() {
  const viewer = await requirePageViewer(undefined, "/");
  const surface = getRuntimeConfig().productSurface;

  return <SurfaceHome surface={surface} demo={viewer.demo} />;
}
