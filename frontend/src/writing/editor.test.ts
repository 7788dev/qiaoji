import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Crepe } from "@milkdown/crepe";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { DocumentEditor } from "./editor";
import { testController } from "./test-support";
import { isDirty } from "./types";

const editors: DocumentEditor[] = [];
const controllers: ReturnType<typeof testController>["controller"][] = [];
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    unobserve() {}
    disconnect() {}
  });
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 10, 20);
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView = () => {};
  document.elementFromPoint = () => null;
  window.scrollBy = () => {};
});
afterEach(async () => {
  for (const editor of editors.splice(0)) editor.destroy();
  for (const controller of controllers.splice(0)) controller.dispose();
  document.body.replaceChildren();
  await new Promise((resolve) => setTimeout(resolve, 20));
});
async function fixture(content = "") {
  const test = testController();
  controllers.push(test.controller);
  await test.controller.start();
  const doc = test.controller.active!;
  doc.content = content;
  doc.savedContent = content;
  const editor = new DocumentEditor(doc, test.controller);
  document.body.append(editor.root);
  editors.push(editor);
  const off = test.controller.subscribe((kind, id) => {
    if (kind === "content" && id === doc.id) editor.sync();
  });
  await editor.show();
  return { ...test, doc, editor, off };
}

describe("retained Markdown editors", () => {
  it("opens and switches modes without normalizing source or creating a dirty buffer", async () => {
    const source = "\ufeff---\r\nid: 'shared'\r\ncustom: true\r\n---\r\n\r\n# 中文\r\n\r\n__加粗__\r\n\r\n* 项目\r\n";
    const { controller, editor, doc } = await fixture(source);
    expect(editor.richHost.querySelector("h1")?.textContent).toBe("中文");
    expect(editor.richHost.querySelector("strong")?.textContent).toBe("加粗");
    editor.flush();
    controller.setMode(doc.id, "source");
    await editor.show();
    controller.setMode(doc.id, "rich");
    await editor.show();
    editor.flush();
    expect(doc.content).toBe(source);
    expect(isDirty(doc)).toBe(false);
  });

  it("keeps rich undo separate across tabs and restores each document's own history", async () => {
    const { controller, editor: a, doc: first } = await fixture();
    await a.insertMarkdown("第一篇");
    a.hide();
    const second = await controller.newDocument();
    const b = new DocumentEditor(second, controller);
    editors.push(b);
    document.body.append(b.root);
    await b.show();
    await b.insertMarkdown("第二篇");
    b.hide();
    controller.activate(first.id);
    await a.show();
    await a.format("undo");
    expect(first.content).toBe("");
    expect(second.content).toContain("第二篇");
    await a.format("redo");
    expect(first.content).toContain("第一篇");
    a.hide();
    controller.activate(second.id);
    await b.show();
    await b.format("undo");
    expect(second.content).toBe("");
    expect(first.content).toContain("第一篇");
  });

  it("keeps source edits and undo history when returning from the other tab", async () => {
    const { controller, editor, doc } = await fixture("原文");
    controller.setMode(doc.id, "source");
    await editor.show();
    await editor.insertMarkdown("源码编辑 ");
    const afterEdit = doc.content;
    expect(afterEdit).toContain("源码编辑");
    editor.hide();
    await controller.newDocument();
    controller.activate(doc.id);
    await editor.show();
    await editor.format("undo");
    expect(doc.content).toBe("原文");
    await editor.format("redo");
    expect(doc.content).toBe(afterEdit);
  });

  it("presents tables, tasks and formulas as editable document content", async () => {
    const { editor, doc } = await fixture("# 表格\n\n| A | B |\n| --- | --- |\n| 一 | 二 |\n\n- [ ] 任务\n\n$$\nE = mc^2\n$$\n");
    expect(editor.richHost.querySelectorAll("td")).toHaveLength(2);
    expect(editor.richHost.querySelector(".milkdown-list-item-block")).not.toBeNull();
    await vi.waitFor(() => expect(editor.richHost.querySelector(".katex")).not.toBeNull());
    await editor.insertMarkdown("正文");
    expect(doc.content).toContain("| A");
    expect(doc.content).toContain("E = mc^2");
    expect(doc.content).toMatch(/[-*] \[ \] 任务/);
  });

  it.each(["rich", "source"] as const)("retains the selected range after returning to a %s tab", async (mode) => {
    const { controller, editor, doc } = await fixture("前面 保留 后面");
    controller.setMode(doc.id, mode);
    await editor.show();
    expect(editor.find("保留").total).toBe(1);
    editor.hide();
    await controller.newDocument();
    controller.activate(doc.id);
    await editor.show();
    expect(editor.replace("保留", "已替换", false)).toBe(1);
    expect(doc.content).toContain("前面 已替换 后面");
  });

  it("preserves image descriptions and titles after editing rich text", async () => {
    const { editor, doc } = await fixture('正文\n\n![中文说明](assets/photo.png "图片标题")\n\n![0.50](assets/number.png)\n\n行内 ![行内说明](assets/inline.png "行内标题") 图片。\n');
    await editor.insertMarkdown("新增文字");
    expect(doc.content).toContain('![中文说明](assets/photo.png "图片标题")');
    expect(doc.content).toContain("![0.50](assets/number.png)");
    expect(doc.content).toContain('![行内说明](assets/inline.png "行内标题")');
    expect(doc.content).not.toContain("![1.00]");
  });

  it("continues an empty task item without switching to source mode", async () => {
    const { editor, doc } = await fixture("- [ ] 第一项\n\n后面的正文\n");
    const view = (editor as unknown as { crepe: Crepe }).crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    let end = 0;
    view.state.doc.descendants((node, position) => {
      if (node.text === "第一项") end = position + node.nodeSize;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    const enter = new KeyboardEvent("keydown", { key: "Enter", code: "Enter" });
    expect(view.someProp("handleKeyDown", (handle) => handle(view, enter))).toBe(true);
    editor.flush();
    expect(doc.mode).toBe("rich");
    expect(doc.content).not.toContain("<br");
    view.dispatch(view.state.tr.insertText("第二项"));
    editor.flush();
    expect(doc.content).toMatch(/[-*] \[ \] 第一项/);
    expect(doc.content).toMatch(/[-*] \[ \] 第二项/);
  });

  it("retains raw HTML and unknown syntax in source mode after external reload", async () => {
    const { controller, editor, doc } = await fixture("原文");
    const source = "---\nid: keep\n---\n<div onclick='alert(1)'>不能执行</div>\n";
    controller.changed(doc.id, source);
    await editor.show();
    expect(doc.mode).toBe("source");
    expect(editor.sourceHost.hidden).toBe(false);
    expect(editor.richHost.hidden).toBe(true);
    editor.flush();
    expect(doc.content).toBe(source);
    expect(editor.root.querySelector("[onclick]")).toBeNull();
  });

  it("keeps the raw buffer unchanged during Chinese IME composition", async () => {
    const { editor, doc, bridge } = await fixture();
    const view = (editor as unknown as { crepe: Crepe }).crepe.editor.action((ctx) => ctx.get(editorViewCtx));
    Object.defineProperty(view, "composing", { value: true, configurable: true });
    view.dispatch(view.state.tr.insertText("中文输入"));
    editor.flush();
    expect(doc.content).toBe("");
    expect(bridge.saveDocument).not.toHaveBeenCalled();
    Object.defineProperty(view, "composing", { value: false, configurable: true });
    editor.richHost.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文输入" }));
    await vi.waitFor(() => expect(doc.content).toContain("中文输入"));
    await editor.format("undo");
    expect(doc.content).toBe("");
  });

  it("renders inline math with bounded sizing and without trusted HTML", async () => {
    const { editor, doc } = await fixture("公式 $\\rule{1000em}{1000em}$ 与 $\\href{javascript:alert(1)}{危险}$。\n");
    const inline = editor.richHost.querySelector('[data-type="math_inline"]');
    expect(inline?.querySelector(".katex")).not.toBeNull();
    expect(editor.richHost.querySelector('[href^="javascript:"]')).toBeNull();
    const styles = Array.from(inline?.querySelectorAll("[style]") ?? []).map((node) => node.getAttribute("style")).join(" ");
    expect(styles).not.toContain("1000em");
    editor.flush();
    expect(isDirty(doc)).toBe(false);
  });
});
