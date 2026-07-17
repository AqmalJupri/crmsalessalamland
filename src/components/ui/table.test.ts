/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "./table";

afterEach(cleanup);

describe("Table", () => {
  it("provides a hidden caption and semantic column scopes", () => {
    render(createElement(
      Table,
      { responsive: "stack", containerLabel: "Senarai lead" },
      createElement(TableCaption, null, "Senarai lead"),
      createElement(TableHeader, null, createElement(
        TableRow,
        null,
        createElement(TableHead, null, "Lead"),
        createElement(TableHead, null, "Status"),
      )),
      createElement(TableBody, null, createElement(
        TableRow,
        null,
        createElement(TableCell, { label: "Lead" }, "Hana Lee"),
        createElement(TableCell, { label: "Status" }, "Baharu"),
      )),
    ));

    const caption = screen.getByText("Senarai lead");
    expect(caption.tagName).toBe("CAPTION");
    expect(caption.classList.contains("crm-visually-hidden")).toBe(true);
    for (const header of screen.getAllByRole("columnheader")) {
      expect(header.getAttribute("scope")).toBe("col");
    }
    const region = screen.getByRole("region", { name: "Senarai lead" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.querySelector("table")).toBe(screen.getByRole("table"));
  });

  it("uses compact mobile divider rows instead of one card per record", () => {
    const css = readFileSync(resolve(process.cwd(), "src/styles/theme.css"), "utf8");
    const rowRule = css.match(
      /\.crm-table-region\[data-responsive="stack"\] \.crm-table__row\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    const bodyRule = css.match(
      /\.crm-table-region\[data-responsive="stack"\] \.crm-table__body\s*\{([^}]*)\}/,
    )?.[1] ?? "";

    expect(rowRule).toContain("border-bottom");
    expect(rowRule).not.toMatch(/border-radius|background:/);
    expect(bodyRule).not.toContain("gap:");
  });
});
