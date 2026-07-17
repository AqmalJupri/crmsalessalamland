/** @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UnsavedChangesDialog } from "./unsaved-changes-dialog";

afterEach(cleanup);

describe("UnsavedChangesDialog", () => {
  it("names the form and requires the explicit discard action", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onDiscard = vi.fn();
    const { container } = render(createElement(UnsavedChangesDialog, {
      formName: "Lead baharu",
      onCancel,
      onDiscard,
      open: true,
    }));

    const dialog = screen.getByRole("dialog", { name: "Buang perubahan?" });
    expect(within(dialog).getByText("Perubahan dalam Lead baharu akan dibuang.")).toBeTruthy();

    const backdrop = container.querySelector(".crm-modal-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    expect(onDiscard).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Buang perubahan" }));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it("traps focus, cancels with Escape, and restores the opener", async () => {
    const user = userEvent.setup();
    const opener = document.createElement("button");
    opener.textContent = "Batal borang";
    document.body.append(opener);
    opener.focus();
    const onCancel = vi.fn();
    const { rerender } = render(createElement(UnsavedChangesDialog, {
      formName: "Lead baharu",
      onCancel,
      onDiscard: vi.fn(),
      open: true,
    }));

    const cancel = screen.getByRole("button", { name: "Kekalkan perubahan" });
    const discard = screen.getByRole("button", { name: "Buang perubahan" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(discard);
    await user.tab();
    expect(document.activeElement).toBe(cancel);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(createElement(UnsavedChangesDialog, {
      formName: "Lead baharu",
      onCancel,
      onDiscard: vi.fn(),
      open: false,
    }));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });
});
