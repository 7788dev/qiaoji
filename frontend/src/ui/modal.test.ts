import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeModal, openModal } from "./modal";

function shell(): HTMLElement {
  return document.getElementById("app") as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  const app = document.createElement("div");
  app.id = "app";
  document.body.appendChild(app);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

/** Dialog teardown is animated, with a timeout as the fallback. */
function settle(): void {
  vi.advanceTimersByTime(500);
}

/** jsdom leaves `inert` undefined until something assigns it. */
function shellIsInert(): boolean {
  return Boolean(shell().inert);
}

describe("openModal", () => {
  it("takes the shell out of the tab order while a dialog is up", () => {
    expect(shellIsInert()).toBe(false);

    const handle = openModal({ title: "测试", body: "内容" });
    expect(shellIsInert()).toBe(true);

    handle.close();
    settle();
    expect(shellIsInert()).toBe(false);
  });

  it("keeps the shell inert until the last dialog goes", () => {
    const first = openModal({ title: "第一层", body: "内容" });
    const second = openModal({ title: "第二层", body: "内容" });

    first.close();
    settle();
    expect(shellIsInert()).toBe(true);

    second.close();
    settle();
    expect(shellIsInert()).toBe(false);
  });

  it("tracks the topmost dialog even when they close out of order", () => {
    const first = openModal({ title: "第一层", body: "内容" });
    const second = openModal({ title: "第二层", body: "内容" });
    expect(activeModal()).toBe(second);

    // Escape targets whatever this reports, so an underlying dialog closing
    // first must not leave it pointing at something already gone.
    first.close();
    settle();
    expect(activeModal()).toBe(second);

    second.close();
    settle();
    expect(activeModal()).toBeNull();
  });

  it("runs onClose exactly once", () => {
    const onClose = vi.fn();
    const handle = openModal({ title: "测试", body: "内容", onClose });

    handle.close();
    handle.close();
    settle();

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
