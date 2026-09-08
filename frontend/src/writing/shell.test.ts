import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountWritingShell } from "./shell";
import { testController, testSettings } from "./test-support";

const { format } = vi.hoisted(() => ({ format: vi.fn(async () => {}) }));
vi.mock("./editor", () => ({
  DocumentEditor: class {
    root = document.createElement("div");
    format = format;
    constructor() {
      const input = document.createElement("div");
      input.className = "ProseMirror";
      input.contentEditable = "true";
      this.root.append(input);
    }
    async show() {}
    applySettings() {}
    hide() {}
    destroy() {}
  },
}));
vi.mock("../api", () => ({ windowIsMaximised: async () => false }));

let dispose: (() => void) | undefined;
beforeEach(() => {
  format.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--ui-scale");
  vi.unstubAllGlobals();
});

async function fixture() {
  const settings = testSettings();
  settings.zoom = 150;
  settings.fontSize = 18;
  const test = testController(settings);
  await test.controller.start();
  const doc = test.controller.active!;
  doc.content = "# 保留当前编辑";
  const root = document.createElement("div");
  document.body.append(root);
  dispose = mountWritingShell(root, test.controller);
  return { ...test, doc, root };
}

describe("application zoom recovery", () => {
  it("shows non-default zoom and resets it without changing or saving the document", async () => {
    const { controller, bridge, doc, root } = await fixture();
    const status = root.querySelector<HTMLButtonElement>(".status-zoom")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("150%");
    status.click();
    await vi.waitFor(() => expect(bridge.saveSettings).toHaveBeenCalled());
    expect(controller.settings.zoom).toBe(100);
    expect(controller.settings.fontSize).toBe(18);
    expect(status.hidden).toBe(true);
    expect(doc.content).toBe("# 保留当前编辑");
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    expect(bridge.saveDocumentAs).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
  });

  it("keeps paragraph formatting separate from the zoom reset shortcut and respects composition", async () => {
    const { controller, root } = await fixture();
    const input = root.querySelector(".ProseMirror")!;
    const press = (options: KeyboardEventInit) => input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "0", ctrlKey: true, bubbles: true, cancelable: true, ...options,
    }));
    press({ altKey: true, isComposing: true });
    expect(controller.settings.zoom).toBe(150);
    press({});
    expect(format).toHaveBeenCalledWith("paragraph");
    expect(controller.settings.zoom).toBe(150);
    format.mockClear();
    press({ altKey: true });
    expect(controller.settings.zoom).toBe(100);
    expect(format).not.toHaveBeenCalled();
  });
});
