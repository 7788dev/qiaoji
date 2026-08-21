import { beforeEach, describe, expect, it, vi } from "vitest";

import { VirtualList } from "./virtual";

interface Item {
  id: string;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});

describe("VirtualList keyed reconciliation", () => {
  it("retains nodes while keeping DOM order in step with sorted items", () => {
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "clientHeight", { value: 200 });
    document.body.appendChild(scroller);

    const list = new VirtualList<Item>({
      scroller,
      rowHeight: 32,
      overscan: 0,
      key: (item) => item.id,
      render: (item) => {
        const node = document.createElement("button");
        node.dataset.id = item.id;
        return node;
      },
      update: (node, item, index) => {
        node.dataset.id = item.id;
        node.dataset.index = String(index);
      },
    });

    list.setItems([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const originalA = scroller.querySelector<HTMLElement>('[data-id="a"]');

    list.setItems([{ id: "c" }, { id: "a" }, { id: "b" }], {
      preserveScroll: true,
    });

    const nodes = Array.from(scroller.querySelectorAll<HTMLElement>("[data-id]"));
    expect(nodes.map((node) => node.dataset.id)).toEqual(["c", "a", "b"]);
    expect(nodes[1]).toBe(originalA);

    list.destroy();
    scroller.remove();
  });
});
