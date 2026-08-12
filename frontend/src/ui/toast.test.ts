import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notify, toast } from "./toast";

function visible(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".toast:not(.is-leaving)"));
}

beforeEach(() => {
  vi.useFakeTimers();
  document.querySelectorAll(".toast").forEach((node) => node.remove());
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("toast", () => {
  it("counts a repeated message instead of stacking duplicates", () => {
    notify.error("笔记库不可访问");
    notify.error("笔记库不可访问");
    notify.error("笔记库不可访问");

    expect(visible()).toHaveLength(1);
    expect(visible()[0].querySelector(".toast__count")?.textContent).toBe("×3");
  });

  it("caps how many can pile up at once", () => {
    for (let i = 0; i < 12; i++) notify.error(`第 ${i} 个错误`);
    expect(visible().length).toBeLessThanOrEqual(4);
  });

  it("keeps toasts with an action separate, so undo targets the right item", () => {
    const first = vi.fn();
    const second = vi.fn();

    // Both deletes report the same sentence, but each Undo restores a
    // different trash entry; folding them together would lose one.
    toast("已移入回收站", { kind: "success", action: { label: "撤销", run: first } });
    toast("已移入回收站", { kind: "success", action: { label: "撤销", run: second } });

    const buttons = document.querySelectorAll<HTMLButtonElement>(".toast__action");
    expect(buttons).toHaveLength(2);

    buttons[1].click();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("dismisses itself after its duration", () => {
    notify.info("已保存");
    expect(visible()).toHaveLength(1);

    vi.advanceTimersByTime(5000);
    expect(visible()).toHaveLength(0);
  });
});
