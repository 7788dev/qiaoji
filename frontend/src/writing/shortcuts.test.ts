import { describe, expect, it, vi } from "vitest";
import { installShortcuts } from "../shortcuts";

describe("document formatting shortcuts", () => {
  it("leaves search fields and IME composition alone", () => {
    const format = vi.fn();
    const stop = installShortcuts([{
      key: "b", ctrl: true,
      when: (event) => Boolean((event.target as Element)?.closest(".ProseMirror")),
      run: format,
    }], () => false);
    const search = document.createElement("input");
    const editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.contentEditable = "true";
    document.body.append(search, editor);
    try {
      const inSearch = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true, cancelable: true });
      search.dispatchEvent(inSearch);
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, isComposing: true, bubbles: true }));
      expect(inSearch.defaultPrevented).toBe(false);
      expect(format).not.toHaveBeenCalled();
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }));
      expect(format).toHaveBeenCalledOnce();
    } finally {
      stop();
      search.remove();
      editor.remove();
    }
  });
});
