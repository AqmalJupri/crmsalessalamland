import "server-only";

import { forbidden, notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getRuntimeConfig } from "@/server/env";
import {
  BusinessScopeError,
  resolveAuthorizedBusinessScope,
  type BusinessUnitReadScope,
} from "@/domain/business-units/read-scope";
import { safeReturnTo } from "./return-to";
import { parseBusinessScopeQuery, scopedHref } from "./business-scope";
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

export async function requireScopedPageViewer(
  rawBu: string | readonly string[] | null | undefined,
  capability: string | undefined,
  returnToPath: string,
  searchParams: Readonly<Record<string, string | readonly string[] | undefined>> = {},
): Promise<{ viewer: Viewer; scope: BusinessUnitReadScope }> {
  let requestedCode: string | null;
  try {
    requestedCode = parseBusinessScopeQuery(rawBu);
  } catch (error) {
    if (error instanceof BusinessScopeError) notFound();
    throw error;
  }

  const currentUrl = new URL(safeReturnTo(returnToPath), "https://scope.invalid");
  for (const [key, rawValue] of Object.entries(searchParams)) {
    if (key === "bu" || rawValue === undefined) continue;
    currentUrl.searchParams.delete(key);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) currentUrl.searchParams.append(key, value);
  }
  if (requestedCode) currentUrl.searchParams.set("bu", requestedCode);
  const safeDestination = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
  const viewer = await getViewer();
  if (!viewer) {
    redirect(`/login?returnTo=${encodeURIComponent(safeDestination)}`);
  }

  try {
    const scope = resolveAuthorizedBusinessScope(
      viewer,
      requestedCode,
      getRuntimeConfig().productSurface,
      capability,
    );
    if (requestedCode === null) {
      redirect(scopedHref(safeDestination, scope.queryValue));
    }
    return { viewer, scope };
  } catch (error) {
    if (error instanceof BusinessScopeError) {
      if (error.code === "INVALID_SCOPE" || error.code === "INVALID_VIEWER_SCOPE") {
        notFound();
      }
      forbidden();
    }
    throw error;
  }
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
    const surface = getRuntimeConfig().productSurface;
    if (!access.surfaces.includes(surface)) {
      notFound();
    }
    return children;
  };
}
