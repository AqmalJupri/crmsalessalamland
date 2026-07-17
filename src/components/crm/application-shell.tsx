"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  Boxes,
  ClipboardCheck,
  ContactRound,
  LayoutDashboard,
  Megaphone,
  PackageCheck,
  Settings,
  ShieldCheck,
  UsersRound,
  WalletCards,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui";
import {
  getProductNavigationSections,
  getProductRouteTitle,
  type ProductNavigationHref,
} from "@/config/product-navigation";
import {
  getProductSurfaceSpec,
  type ProductSurface,
} from "@/config/product-surface";
import { AppShell, type SidebarNavItem } from "./app-shell";

export interface ShellViewer {
  displayName: string;
  businessUnitId: string;
  businessUnits: readonly { id: string; name: string; slug: string; code: string }[];
  capabilities: readonly string[];
  demo: boolean;
}

const navigationIcons = {
  "/": LayoutDashboard,
  "/leads": ContactRound,
  "/pipeline": Workflow,
  "/tasks": ClipboardCheck,
  "/orders": PackageCheck,
  "/inventory": Boxes,
  "/finance": WalletCards,
  "/marketing": Megaphone,
  "/reports": BarChart3,
  "/team": UsersRound,
  "/settings": Settings,
} as const satisfies Record<ProductNavigationHref, LucideIcon>;

const crmDemoCounts = {
  "/leads": 8,
  "/tasks": 7,
} as const satisfies Partial<Record<ProductNavigationHref, number>>;

function routeRoot(pathname: string): string {
  if (pathname === "/") return "/";
  return `/${pathname.split("/").filter(Boolean)[0] ?? ""}`;
}

export function ApplicationShell({
  children,
  surface,
  viewer,
}: {
  children: React.ReactNode;
  surface: ProductSurface;
  viewer: ShellViewer;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const activeHref = routeRoot(pathname);
  const initialUnit =
    viewer.businessUnits.find((unit) => unit.id === viewer.businessUnitId) ?? viewer.businessUnits[0]!;
  const [selectedUnit, setSelectedUnit] = useState(initialUnit);

  const surfaceSpec = getProductSurfaceSpec(surface);
  const title = getProductRouteTitle(surface, pathname);
  const navWithActive = useMemo(
    () => getProductNavigationSections(surface)
      .map((section) => ({
        ...section,
        items: section.items
          .filter(
            (item) =>
              !("capability" in item) ||
              viewer.capabilities.includes(item.capability),
          )
          .map((item): SidebarNavItem => ({
            label: item.label,
            href: item.href,
            icon: navigationIcons[item.href],
            ...(surface === "crm" && viewer.demo && item.href in crmDemoCounts
              ? { count: crmDemoCounts[item.href as keyof typeof crmDemoCounts] }
              : {}),
            active: item.href === activeHref,
          })),
      }))
      .filter((section) => section.items.length > 0),
    [activeHref, surface, viewer.capabilities, viewer.demo],
  );

  function cycleWorkspace(): void {
    const currentIndex = viewer.businessUnits.findIndex((unit) => unit.id === selectedUnit.id);
    const next = viewer.businessUnits[(currentIndex + 1) % viewer.businessUnits.length];
    if (!next) return;
    setSelectedUnit(next);
    document.cookie = `crm_bu=${encodeURIComponent(next.id)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.refresh();
  }

  return (
    <AppShell
      activeHref={activeHref}
      navigation={navWithActive}
      title={title}
      brand={{ name: surfaceSpec.productName, mark: surface === "crm" ? "S" : "T" }}
      workspace={{
        name: selectedUnit.name,
        ...(viewer.businessUnits.length > 1
          ? {
              onClick: cycleWorkspace,
              ariaLabel: `Tukar syarikat. Semasa: ${selectedUnit.name}`,
            }
          : {}),
      }}
      user={{ name: viewer.displayName }}
      sidebarFooter={surface === "crm" ? (
        <Badge variant={viewer.demo ? "info" : "success"} icon={ShieldCheck}>
          {viewer.demo ? "Demo tempatan" : "Tersambung"}
        </Badge>
      ) : undefined}
    >
      {children}
    </AppShell>
  );
}
