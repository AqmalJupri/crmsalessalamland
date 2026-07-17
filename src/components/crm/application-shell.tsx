"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
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
import type { PublicViewer } from "@/domain/auth/public-viewer";
import {
  getProductNavigationSections,
  getProductNavigationItem,
  getProductRouteTitle,
  type ProductNavigationHref,
} from "@/config/product-navigation";
import {
  getProductSurfaceSpec,
  type ProductSurface,
} from "@/config/product-surface";
import { AppShell, type SidebarNavItem } from "./app-shell";
import { BusinessUnitSwitcher } from "./business-unit-switcher";

export type ShellViewer = PublicViewer;

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
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const activeHref = routeRoot(pathname);
  const surfaceUnits = surface === "tasha"
    ? viewer.businessUnitAccess.filter((unit) => unit.code === "salam-land")
    : viewer.businessUnitAccess;
  const requestedCodes = searchParams.getAll("bu");
  const fallbackUnit =
    surfaceUnits.find((unit) => unit.id === viewer.businessUnitId) ?? surfaceUnits[0];
  const requestedCode = requestedCodes.length === 1 ? requestedCodes[0]! : fallbackUnit?.code;
  const selectedCode: string = requestedCode !== undefined && (
    requestedCode === "all" || surfaceUnits.some((unit) => unit.code === requestedCode)
  )
    ? requestedCode
    : fallbackUnit?.code ?? "all";
  const selectedUnit = selectedCode === "all"
    ? undefined
    : surfaceUnits.find((unit) => unit.code === selectedCode);
  const activeItem = getProductNavigationItem(pathname);
  const activeCapability = activeItem && "capability" in activeItem
    ? activeItem.capability
    : undefined;
  const switcherUnits = activeCapability
    ? surfaceUnits.filter((unit) => unit.capabilities.includes(activeCapability))
    : surfaceUnits;

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
              (selectedCode === "all"
                ? surfaceUnits.some((unit) => unit.capabilities.includes(item.capability))
                : selectedUnit?.capabilities.includes(item.capability) === true),
          )
          .map((item): SidebarNavItem => ({
            label: item.label,
            href: `${item.href}?${new URLSearchParams({ bu: selectedCode })}`,
            icon: navigationIcons[item.href],
            active: item.href === activeHref,
          })),
      }))
      .filter((section) => section.items.length > 0),
    [activeHref, selectedCode, selectedUnit, surface, surfaceUnits],
  );

  return (
    <AppShell
      activeHref={activeHref}
      routeKey={`${pathname}${search ? `?${search}` : ""}`}
      navigation={navWithActive}
      title={title}
      brand={{ name: surfaceSpec.productName, mark: surface === "crm" ? "S" : "T" }}
      workspace={(
        <BusinessUnitSwitcher
          units={switcherUnits}
          selectedCode={selectedCode}
        />
      )}
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
