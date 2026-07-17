import {
  getProductSurfaceSpec,
  type ProductSurface,
} from "./product-surface";

export interface ProductNavigationItem {
  label: string;
  title: string;
  href: string;
  capability?: string;
  surfaces: readonly ProductSurface[];
  order: Readonly<
    Partial<Record<ProductSurface, readonly [section: number, item: number]>>
  >;
}

export const PRODUCT_REQUEST_PATH_HEADER = "x-salam-request-path";

export const PRODUCT_NAVIGATION = [
  {
    label: "Utama",
    title: "Utama",
    href: "/",
    surfaces: ["crm", "tasha"],
    order: { crm: [0, 0], tasha: [0, 0] },
  },
  {
    label: "Lead",
    title: "Lead",
    href: "/leads",
    capability: "lead.read",
    surfaces: ["crm"],
    order: { crm: [0, 1] },
  },
  {
    label: "Pipeline",
    title: "Pipeline",
    href: "/pipeline",
    capability: "opportunity.read",
    surfaces: ["crm"],
    order: { crm: [0, 2] },
  },
  {
    label: "Tugasan",
    title: "Tugasan",
    href: "/tasks",
    capability: "task.read",
    surfaces: ["crm", "tasha"],
    order: { crm: [0, 3], tasha: [0, 4] },
  },
  {
    label: "Pesanan",
    title: "Pesanan",
    href: "/orders",
    capability: "order.read",
    surfaces: ["crm", "tasha"],
    order: { crm: [1, 0], tasha: [0, 2] },
  },
  {
    label: "Inventori",
    title: "Inventori",
    href: "/inventory",
    capability: "inventory.read",
    surfaces: ["crm", "tasha"],
    order: { crm: [1, 1], tasha: [0, 1] },
  },
  {
    label: "Kewangan",
    title: "Kewangan",
    href: "/finance",
    capability: "finance.read",
    surfaces: ["crm", "tasha"],
    order: { crm: [1, 2], tasha: [0, 3] },
  },
  {
    label: "Pemasaran",
    title: "Pemasaran",
    href: "/marketing",
    capability: "marketing.read",
    surfaces: ["crm"],
    order: { crm: [2, 0] },
  },
  {
    label: "Laporan",
    title: "Laporan",
    href: "/reports",
    capability: "report.read",
    surfaces: ["crm", "tasha"],
    order: { crm: [2, 1], tasha: [0, 5] },
  },
  {
    label: "Pasukan",
    title: "Pasukan",
    href: "/team",
    capability: "team.read",
    surfaces: ["crm"],
    order: { crm: [3, 0] },
  },
  {
    label: "Tetapan",
    title: "Tetapan",
    href: "/settings",
    capability: "settings.read",
    surfaces: ["crm"],
    order: { crm: [3, 1] },
  },
] as const satisfies readonly ProductNavigationItem[];

export type ProductNavigationDefinition = (typeof PRODUCT_NAVIGATION)[number];
export type ProductNavigationHref = ProductNavigationDefinition["href"];

const SECTION_LABELS = {
  crm: [undefined, "Operasi", "Pertumbuhan", "Pentadbiran"],
  tasha: [undefined],
} as const satisfies Record<ProductSurface, readonly (string | undefined)[]>;

export interface ProductNavigationSection {
  label?: string;
  items: readonly ProductNavigationDefinition[];
}

function supportsSurface(
  item: ProductNavigationItem,
  surface: ProductSurface,
): boolean {
  return item.surfaces.includes(surface);
}

function orderFor(
  item: ProductNavigationItem,
  surface: ProductSurface,
): readonly [section: number, item: number] | undefined {
  return item.order[surface];
}

export function getProductNavigationSections(
  surface: ProductSurface,
): readonly ProductNavigationSection[] {
  const orderedItems = PRODUCT_NAVIGATION
    .filter((item) => supportsSurface(item, surface))
    .sort((left, right) => {
      const leftOrder = orderFor(left, surface);
      const rightOrder = orderFor(right, surface);
      if (!leftOrder || !rightOrder) {
        throw new Error(`Missing ${surface} navigation order.`);
      }
      return leftOrder[0] - rightOrder[0] || leftOrder[1] - rightOrder[1];
    });

  return SECTION_LABELS[surface].map((label, sectionIndex) => ({
    ...(label ? { label } : {}),
    items: orderedItems.filter(
      (item) => orderFor(item, surface)?.[0] === sectionIndex,
    ),
  }));
}

function findProductNavigationItem(
  pathname: string,
): ProductNavigationDefinition | undefined {
  if (!pathname.startsWith("/")) return undefined;

  return PRODUCT_NAVIGATION.find((candidate) =>
    candidate.href === "/"
      ? pathname === "/"
      : pathname === candidate.href || pathname.startsWith(`${candidate.href}/`),
  );
}

export function isProductPathAvailable(
  surface: ProductSurface,
  pathname: string,
): boolean {
  const item = findProductNavigationItem(pathname);
  return item !== undefined && supportsSurface(item, surface);
}

export function getProductRouteTitle(
  surface: ProductSurface,
  pathname: string,
): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  const item = findProductNavigationItem(path);

  return item && supportsSurface(item, surface)
    ? item.title
    : getProductSurfaceSpec(surface).productName;
}
