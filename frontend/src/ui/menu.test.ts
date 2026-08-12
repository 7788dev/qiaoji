import { afterEach, describe, expect, it, vi } from "vitest";

import { closeMenu, menuIsOpen, showMenu } from "./menu";

afterEach(() => {
  closeMenu();
  document.body.replaceChildren();
});

function items(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".menu__item"));
}

describe("showMenu", () => {
  it("tears down its global listeners when an item is chosen", () => {
    const documentAdd = vi.spyOn(document, "addEventListener");
    const documentRemove = vi.spyOn(document, "removeEventListener");
    const windowAdd = vi.spyOn(window, "addEventListener");
    const windowRemove = vi.spyOn(window, "removeEventListener");

    const run = vi.fn();
    showMenu([{ label: "做点什么", run }], { x: 10, y: 10 });
    expect(menuIsOpen()).toBe(true);

    items()[0].click();

    expect(run).toHaveBeenCalledTimes(1);
    expect(menuIsOpen()).toBe(false);
    // Choosing an item used to bypass teardown, leaving a capture-phase
    // pointerdown and keydown on the document for the rest of the session.
    expect(documentRemove.mock.calls.length).toBe(documentAdd.mock.calls.length);
    expect(windowRemove.mock.calls.length).toBe(windowAdd.mock.calls.length);
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("does not accumulate panels across repeated open-and-choose cycles", () => {
    for (let i = 0; i < 20; i++) {
      showMenu([{ label: `第 ${i} 项`, run: () => undefined }], { x: 0, y: 0 });
      items()[0].click();
    }
    expect(document.querySelectorAll(".menu")).toHaveLength(0);
    expect(menuIsOpen()).toBe(false);
  });

  it("opens a submenu instead of running the parent entry", () => {
    const child = vi.fn();
    showMenu(
      [{ label: "移动到…", children: [{ label: "工作", run: child }] }],
      { x: 0, y: 0 },
    );

    items()[0].click();
    expect(child).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".menu")).toHaveLength(2);

    items().at(-1)?.click();
    expect(child).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".menu")).toHaveLength(0);
  });

  it("skips disabled entries when arrowing through", () => {
    showMenu(
      [
        { label: "可用一", run: () => undefined },
        { label: "不可用", disabled: true, run: () => undefined },
        { label: "可用二", run: () => undefined },
      ],
      { x: 0, y: 0 },
    );

    const event = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
    document.dispatchEvent(event);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    const active = document.querySelector(".menu__item.is-active");
    expect(active?.textContent).toContain("可用二");
  });
});
