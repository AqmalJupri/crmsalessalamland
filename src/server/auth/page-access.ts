import "server-only";

import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getRuntimeConfig } from "@/server/env";
import { safeReturnTo } from "./return-to";
import { getViewer, type Viewer } from "./viewer";
import { CRM_MODULE_ACCESS, type CrmModuleKey } from "./module-access";

export async function requirePageViewer(
  capability: string | undefined,
  returnTo: string,
): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) {
    redirect(`/login?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
  }
  if (capability && !viewer.capabilities.includes(capability)) {
    forbidden();
  }
  return viewer;
}

export function canRenderDemoFixtures(): boolean {
  const config = getRuntimeConfig();
  return config.demoMode && config.nodeEnv !== "production";
}

export function createCrmModuleLayout(moduleKey: CrmModuleKey) {
  const access = CRM_MODULE_ACCESS[moduleKey];

  return async function CrmModuleLayout({
    children,
  }: Readonly<{ children: ReactNode }>): Promise<ReactNode> {
    await requirePageViewer(access.capability, access.returnTo);
    return children;
  };
}
