/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataEmptyState } from "@/components/crm/data-empty-state";
import {
  OPERATION_STATE_KINDS,
  OperationState,
  type OperationStateKind,
} from "./operation-state";

const expectedStates = [
  ["loading", "Memuat data", "loader-circle", "status"],
  ["empty", "Belum ada rekod", "inbox", "region"],
  ["filtered-empty", "Tiada padanan", "search-x", "region"],
  ["stale", "Data lewat", "clock-3", "region"],
  ["syncing", "Menyegerak data", "refresh-cw", "status"],
  ["queued", "Dalam giliran", "list-ordered", "status"],
  ["partial", "Sebahagian selesai", "circle-dashed", "status"],
  ["success", "Tindakan selesai", "circle-check", "status"],
  ["failed", "Tindakan gagal", "circle-x", "alert"],
  ["conflict", "Perubahan bertindih", "git-compare-arrows", "alert"],
  ["offline", "Di luar talian", "wifi-off", "alert"],
  ["forbidden", "Akses ditolak", "shield-x", "alert"],
  ["unknown", "Status tidak diketahui", "circle-help", "region"],
] as const satisfies ReadonlyArray<readonly [OperationStateKind, string, string, string]>;

afterEach(cleanup);

describe("OperationState", () => {
  it("exports the complete, ordered 13-state vocabulary", () => {
    expect(OPERATION_STATE_KINDS).toEqual(expectedStates.map(([kind]) => kind));
    expect(new Set(OPERATION_STATE_KINDS).size).toBe(13);
  });

  it.each(expectedStates)(
    "renders %s with its truthful Malay label, matching icon, and semantic role",
    (kind, label, icon, role) => {
      const { container } = render(createElement(OperationState, { kind }));

      expect(screen.getByRole(role, { name: label })).toBeTruthy();
      expect(container.querySelector(`[data-state-kind="${kind}"]`)).toBeTruthy();
      expect(container.querySelector(`[data-state-icon="${icon}"][aria-hidden="true"]`))
        .toBeTruthy();
    },
  );

  it.each(["loading", "syncing", "queued", "partial", "success"] as const)(
    "announces %s progress or completion politely",
    (kind) => {
      const { container } = render(createElement(OperationState, { kind }));
      const state = container.querySelector(`[data-state-kind="${kind}"]`);

      expect(state?.getAttribute("role")).toBe("status");
      expect(state?.getAttribute("aria-live")).toBe("polite");
      expect(state?.getAttribute("aria-atomic")).toBe("true");
    },
  );

  it.each(["loading", "syncing"] as const)(
    "keeps %s announcable without marking its own live region busy",
    (kind) => {
      const { container } = render(createElement(OperationState, { kind }));
      const state = container.querySelector(`[data-state-kind="${kind}"]`);

      expect(state?.getAttribute("role")).toBe("status");
      expect(state?.getAttribute("aria-live")).toBe("polite");
      expect(state?.getAttribute("aria-busy")).toBeNull();
    },
  );

  it.each(["empty", "filtered-empty", "stale", "unknown"] as const)(
    "keeps static %s content out of live regions",
    (kind) => {
      const { container } = render(createElement(OperationState, { kind }));
      const state = container.querySelector(`[data-state-kind="${kind}"]`);

      expect(state?.getAttribute("role")).toBeNull();
      expect(state?.getAttribute("aria-live")).toBeNull();
    },
  );

  it.each(["failed", "conflict", "offline", "forbidden"] as const)(
    "reserves alerts for actionable %s failures",
    (kind) => {
      render(createElement(OperationState, { kind }));
      expect(screen.getByRole("alert")).toBeTruthy();
    },
  );

  it.each([
    [
      "failed",
      "Sistem mengesahkan permintaan berakhir dengan kegagalan. Semak rekod atau kesan tindakan terkini sebelum cuba semula.",
    ],
    [
      "conflict",
      "Sistem mengesan versi rekod berbeza. Muat semula dan semak perubahan sebelum menyimpan semula.",
    ],
    [
      "offline",
      "Keputusan tindakan belum dapat disahkan kerana sambungan terputus. Selepas talian pulih, semak rekod atau status terkini sebelum cuba semula.",
    ],
    [
      "forbidden",
      "Tindakan disekat kerana akses tidak dibenarkan. Hubungi pentadbir jika akses diperlukan.",
    ],
  ] as const)("makes the default %s alert actionable", (kind, guidance) => {
    render(createElement(OperationState, { kind }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(guidance);
    expect(alert.querySelector(".crm-operation-state__details")).toBeTruthy();
  });

  it("keeps retry after a confirmed failure safe for idempotent side effects", () => {
    render(createElement(OperationState, { kind: "failed" }));

    const normalized = (screen.getByRole("alert").textContent ?? "").toLocaleLowerCase("ms");
    const checkIndex = normalized.indexOf("semak rekod atau kesan tindakan terkini");
    const retryIndex = normalized.indexOf("cuba semula");
    expect(normalized).toContain("mengesahkan permintaan berakhir dengan kegagalan");
    expect(normalized).not.toMatch(/tidak disimpan|belum dihantar|tidak direkod|tidak dipadam/);
    expect(checkIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(checkIndex);
  });

  it("does not turn an uncertain offline outcome into a blind retry", () => {
    render(createElement(OperationState, { kind: "offline" }));

    const normalized = (screen.getByRole("alert").textContent ?? "").toLocaleLowerCase("ms");
    const checkIndex = normalized.indexOf("semak rekod atau status terkini");
    const retryIndex = normalized.indexOf("cuba semula");
    expect(normalized).not.toMatch(/tidak disimpan|belum dihantar/);
    expect(checkIndex).toBeGreaterThan(-1);
    expect(retryIndex).toBeGreaterThan(checkIndex);
  });

  it("keeps confirmed failure semantically distinct from an unknown outcome", () => {
    const { rerender } = render(createElement(OperationState, { kind: "failed" }));
    const failed = screen.getByRole("alert", { name: "Tindakan gagal" });
    expect(failed.textContent).toContain("mengesahkan permintaan berakhir dengan kegagalan");

    rerender(createElement(OperationState, { kind: "unknown" }));
    const unknown = screen.getByRole("region", { name: "Status tidak diketahui" });
    expect(unknown.textContent).toContain("Keputusan tindakan belum dapat dipastikan");
    expect(unknown.textContent).not.toContain("kegagalan");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses evidence-bounded defaults for conflict and forbidden outcomes", () => {
    const { rerender } = render(createElement(OperationState, { kind: "conflict" }));
    expect(screen.getByRole("alert").textContent).not.toContain("belum disimpan");
    expect(screen.getByRole("alert").textContent).toContain("versi rekod berbeza");

    rerender(createElement(OperationState, { kind: "forbidden" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Tindakan disekat kerana akses tidak dibenarkan",
    );
  });

  it("retains the target, consequence, reason, and next step for a financial failure", () => {
    render(createElement(OperationState, {
      kind: "failed",
      label: "Bayaran Pesanan SL-TEST-001 gagal",
      details: "Bayaran tidak direkod kerana rujukan bank ditolak. Semak rujukan dan cuba lagi.",
      action: createElement("button", { type: "button" }, "Semak rujukan"),
    }));

    const alert = screen.getByRole("alert", { name: "Bayaran Pesanan SL-TEST-001 gagal" });
    expect(alert.textContent).toContain("Bayaran tidak direkod");
    expect(alert.textContent).toContain("rujukan bank ditolak");
    expect(alert.textContent).toContain("Semak rujukan dan cuba lagi");
    expect(screen.getByRole("button", { name: "Semak rujukan" })).toBeTruthy();
  });

  it.each([
    [
      "destructive",
      "Lead Nur Test tidak dipadam",
      "Lead Nur Test kekal kerana sebab pemadaman belum diberi. Isi sebab dan cuba lagi.",
      "Isi sebab",
    ],
    [
      "consent",
      "Mesej Kontak TEST disekat",
      "Mesej tidak dihantar kerana persetujuan WhatsApp tiada. Semak persetujuan sebelum menghantar semula.",
      "Semak persetujuan",
    ],
    [
      "security",
      "Tetapan Meta tidak berubah",
      "Perubahan disekat kerana pengesahan tambahan diperlukan. Sahkan identiti dan cuba lagi.",
      "Sahkan identiti",
    ],
  ])("retains complete %s failure context", (_category, label, details, action) => {
    render(createElement(OperationState, {
      kind: "failed",
      label,
      details,
      action: createElement("button", { type: "button" }, action),
    }));

    const alert = screen.getByRole("alert", { name: label });
    expect(alert.textContent).toContain(details);
    expect(screen.getByRole("button", { name: action })).toBeTruthy();
  });

  it("keeps DataEmptyState as an empty-state compatibility wrapper", () => {
    const { container } = render(createElement(DataEmptyState, { label: "Belum ada lead." }));

    expect(screen.getByRole("region", { name: "Belum ada lead." })).toBeTruthy();
    expect(container.querySelector('[data-state-kind="empty"]')).toBeTruthy();
  });

  it.each([
    ["src/app/(crm)/page.tsx", /emptyStateKind="empty"/],
    ["src/app/(crm)/finance/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/inventory/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/leads/page.tsx", /emptyStateKind="empty"/],
    ["src/app/(crm)/marketing/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/orders/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/pipeline/page.tsx", /emptyStateKind="empty"/],
    ["src/app/(crm)/reports/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/settings/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/tasks/page.tsx", /<OperationState kind="empty"/],
    ["src/app/(crm)/team/page.tsx", /<OperationState kind="empty"/],
  ])("uses an explicit operational state on %s", (path, expectedContract) => {
    const source = readFileSync(resolve(process.cwd(), path), "utf8");

    expect(source).toMatch(expectedContract);
    expect(source).not.toContain("DataEmptyState");
  });

  it("keeps the legacy empty wrapper out of migrated runtime surfaces", () => {
    for (const path of [
      "src/components/crm/leads-workspace.tsx",
      "src/components/crm/operational-module.tsx",
      "src/components/crm/pipeline-workspace.tsx",
      "src/components/crm/surface-home.tsx",
    ]) {
      expect(readFileSync(resolve(process.cwd(), path), "utf8")).not.toContain("DataEmptyState");
    }
  });

  it("locks the shared spinner animation and reduced-motion fallback", () => {
    const productStyles = readFileSync(
      resolve(process.cwd(), "src/styles/product.css"),
      "utf8",
    );
    const themeStyles = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf8");
    const reducedMotionStart = themeStyles.indexOf("@media (prefers-reduced-motion: reduce)");
    const forcedColorsStart = themeStyles.indexOf(
      "@media (forced-colors: active)",
      reducedMotionStart,
    );
    const reducedMotionStyles = themeStyles.slice(reducedMotionStart, forcedColorsStart);

    expect(productStyles).toMatch(
      /\.crm-operation-state\[data-state-kind="(?:loading|syncing)"\][\s\S]*?animation:\s*crm-spin/,
    );
    expect(themeStyles).toMatch(/@keyframes\s+crm-spin/);
    expect(reducedMotionStart).toBeGreaterThanOrEqual(0);
    expect(forcedColorsStart).toBeGreaterThan(reducedMotionStart);
    expect(reducedMotionStyles).toMatch(/\.crm-theme\s+\*/);
    expect(reducedMotionStyles).toMatch(/animation:\s*none\s*!important/);
  });
});
