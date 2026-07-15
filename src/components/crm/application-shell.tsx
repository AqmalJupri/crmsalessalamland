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
} from "lucide-react";
import { Badge } from "@/components/ui";
import { AppShell, type SidebarNavItem } from "./app-shell";

export interface ShellViewer {
  displayName: string;
  businessUnitId: string;
  businessUnits: readonly { id: string; name: string; slug: string; code: string }[];
  capabilities: readonly string[];
  demo: boolean;
}

type ProtectedNavItem = SidebarNavItem & { capability?: string };

const navigation: { label?: string; items: ProtectedNavItem[] }[] = [
  {
    items: [
      { label: "Utama", href: "/", icon: LayoutDashboard },
      { label: "Lead", href: "/leads", icon: ContactRound, count: 8, capability: "lead.read" },
      { label: "Pipeline", href: "/pipeline", icon: Workflow, capability: "opportunity.read" },
      { label: "Tugasan", href: "/tasks", icon: ClipboardCheck, count: 7, capability: "task.read" },
    ],
  },
  {
    label: "Operasi",
    items: [
      { label: "Pesanan", href: "/orders", icon: PackageCheck, capability: "order.read" },
      { label: "Inventori", href: "/inventory", icon: Boxes, capability: "inventory.read" },
      { label: "Kewangan", href: "/finance", icon: WalletCards, capability: "finance.read" },
    ],
  },
  {
    label: "Pertumbuhan",
    items: [
      { label: "Pemasaran", href: "/marketing", icon: Megaphone, capability: "marketing.read" },
      { label: "Laporan", href: "/reports", icon: BarChart3, capability: "report.read" },
    ],
  },
  {
    label: "Pentadbiran",
    items: [
      { label: "Pasukan", href: "/team", icon: UsersRound, capability: "team.read" },
      { label: "Tetapan", href: "/settings", icon: Settings, capability: "settings.read" },
    ],
  },
];

const pageTitles: Record<string, string> = {
  "/": "Utama",
  "/leads": "Lead",
  "/pipeline": "Pipeline",
  "/tasks": "Tugasan",
  "/orders": "Pesanan",
  "/inventory": "Inventori",
  "/finance": "Kewangan",
  "/marketing": "Pemasaran",
  "/reports": "Laporan",
  "/team": "Pasukan",
  "/settings": "Tetapan",
};

function routeRoot(pathname: string): string {
  if (pathname === "/") return "/";
  return `/${pathname.split("/").filter(Boolean)[0] ?? ""}`;
}

export function ApplicationShell({ children, viewer }: { children: React.ReactNode; viewer: ShellViewer }) {
  const pathname = usePathname();
  const router = useRouter();
  const activeHref = routeRoot(pathname);
  const initialUnit =
    viewer.businessUnits.find((unit) => unit.id === viewer.businessUnitId) ?? viewer.businessUnits[0]!;
  const [selectedUnit, setSelectedUnit] = useState(initialUnit);

  const title = pageTitles[activeHref] ?? "CRM";
  const navWithActive = useMemo(
    () => navigation
      .map((section) => ({
        ...section,
        items: section.items
          .filter(
            (item) =>
              item.capability === undefined ||
              viewer.capabilities.includes(item.capability),
          )
          .map(({ count, ...item }) => ({
            ...item,
            ...(viewer.demo && count !== undefined ? { count } : {}),
            active: item.href === activeHref,
          })),
      }))
      .filter((section) => section.items.length > 0),
    [activeHref, viewer.capabilities, viewer.demo],
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
      brand={{ name: "Salam CRM", mark: "S" }}
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
      sidebarFooter={
        <Badge variant={viewer.demo ? "info" : "success"} icon={ShieldCheck}>
          {viewer.demo ? "Demo tempatan" : "Tersambung"}
        </Badge>
      }
    >
      {children}
    </AppShell>
  );
}
