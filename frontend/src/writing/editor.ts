import { Crepe } from "@milkdown/crepe";
import katex from "katex";
import "@milkdown/crepe/theme/common/style.css";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { Plugin, TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView as ProseView } from "@milkdown/kit/prose/view";
import { toggleMark, setBlockType, wrapIn } from "@milkdown/kit/prose/commands";
import { wrapInList } from "@milkdown/kit/prose/schema-list";
import { undo as proseUndo, redo as proseRedo } from "@milkdown/kit/prose/history";
import { $prose, callCommand, insert } from "@milkdown/kit/utils";
import { insertTableCommand } from "@milkdown/kit/preset/gfm";
import { paragraphSchema } from "@milkdown/kit/preset/commonmark";
import { imageBlockSchema } from "@milkdown/kit/component/image-block";
import { MarkdownEditor, commands as sourceCommands } from "../lib/editor";
import { codeLanguages } from "../lib/codelangs";
import { debounce, el } from "../lib/dom";
import { outlineOf } from "../lib/markdown";
import { prompt } from "../ui/modal";
import type { WritingController } from "./controller";
import type { EditorMode, OpenDocument } from "./types";
import { splitSource, joinSource, sourceOnlyReason } from "./source";

export type FormatAction = "bold" | "italic" | "strike" | "code" | "quote" | "bullet" | "ordered"
  | "task" | "codeblock" | "table" | "math" | "link" | "hr" | "undo" | "redo"
  | "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
interface Match { from: number; to: number }

/** One editor pair per document, so hidden tabs keep their own undo history. */
export class DocumentEditor {
  readonly root = el("div", { class: "document-surface" });
  readonly richHost = el("div", { class: "writing-rich" });
  readonly sourceHost = el("div", { class: "writing-source" });
  private readonly notice = el("div", { class: "source-notice", role: "status", hidden: true });
  private crepe: Crepe | null = null;
  private source: MarkdownEditor | null = null;
  private initialising: Promise<void> | null = null;
  private richReady = false;
  private destroyed = false;
  private syncing = false;
  private richChanged = false;
  private sourceChanged = false;
  private mode: EditorMode = "rich";
  private lastSource: string;
  private richBaseSource = "";
  private richBaseMarkdown = "";
  private envelope: ReturnType<typeof splitSource>;
  private removeFlusher: () => void;
  private flushSoon = debounce(() => this.flush(), 100);
  private positions = new Map<EditorMode, { cursor: number; scroll: number }>();
  private appliedSource = "";
  private appliedRichSource = "";
  private showGeneration = 0;
  private readOnlyApplied: boolean;

  constructor(readonly document: OpenDocument, readonly controller: WritingController) {
    this.lastSource = document.content;
    this.envelope = splitSource(document.content);
    this.readOnlyApplied = document.readOnly;
    this.root.append(this.notice, this.richHost, this.sourceHost);
    this.root.hidden = true;
    this.removeFlusher = controller.registerFlusher(document.id, () => this.flush());
    this.richHost.addEventListener("compositionend", () => setTimeout(() => this.flush(), 0));
    this.richHost.addEventListener("scroll", () => this.rememberPosition(), { passive: true });
    this.richHost.addEventListener("click", (event) => {
      const anchor = (event.target as Element).closest("a[href]");
      if (anchor) event.preventDefault();
    });
  }

  private view(): ProseView | null {
    return this.richReady && this.crepe ? this.crepe.editor.action((ctx) => ctx.get(editorViewCtx)) : null;
  }
  private rememberPosition(): void {
    if (this.syncing || this.root.hidden) return;
    const cursor = this.mode === "source" ? this.source?.view.state.selection.main.head ?? 0 : this.view()?.state.selection.head ?? 0;
    const scroll = this.mode === "source" ? this.source?.view.scrollDOM.scrollTop ?? 0 : this.richHost.scrollTop;
    this.positions.set(this.mode, { cursor, scroll });
    this.controller.position(this.document.id, cursor, scroll);
  }
  private ensureSource(): void {
    if (this.source) return;
    const doc = this.document;
    this.syncing = true;
    this.source = new MarkdownEditor({
      parent: this.sourceHost, doc: doc.content,
      onChange: () => {
        if (this.syncing) return;
        this.sourceChanged = true;
        this.flush();
      },
      onCursor: () => this.rememberPosition(),
      onScroll: () => this.rememberPosition(),
      onSave: () => void this.controller.save(doc.id),
      onImages: (files) => void this.insertImages(files),
    }, this.sourceSettings());
    this.source.setReadOnly(doc.readOnly);
    this.appliedSource = doc.content;
    this.syncing = false;
  }
  private sourceSettings() {
    const settings = this.controller.settings;
    return { sourceMode: true, fontSize: settings.fontSize, lineHeight: settings.lineHeight,
      tabSize: settings.tabSize, showLineNumbers: settings.showLineNumbers, autoPairing: settings.autoPairing,
      width: settings.editorWidth };
  }
  private async ensureRich(): Promise<void> {
    if (this.richReady) return;
    if (this.initialising) return this.initialising;
    this.initialising = (async () => {
      const initialSource = this.document.content;
      const editor = new Crepe({
        root: this.richHost, defaultValue: splitSource(initialSource).body,
        features: {
          [Crepe.Feature.BlockEdit]: false, [Crepe.Feature.Toolbar]: false,
          [Crepe.Feature.TopBar]: false, [Crepe.Feature.AI]: false,
        },
        featureConfigs: {
          // Let WebView2 position the caret under UI zoom and IME composition.
          [Crepe.Feature.Cursor]: { virtual: false },
          [Crepe.Feature.Placeholder]: { text: "从这里开始写…", mode: "doc" },
          [Crepe.Feature.ImageBlock]: {
            onUpload: (file) => this.controller.bridge.uploadImage(this.document.id, file),
            proxyDomURL: async (href) => {
              await Promise.resolve();
              this.flush();
              return this.controller.bridge.assetURL(this.document.id, href, this.document.content);
            },
            inlineUploadButton: "选择图片", blockUploadButton: "选择图片",
            inlineUploadPlaceholderText: "或输入图片地址", blockUploadPlaceholderText: "或输入图片地址",
            blockCaptionPlaceholderText: "图片说明", blockConfirmButton: "确定",
          },
          [Crepe.Feature.LinkTooltip]: { inputPlaceholder: "输入链接地址" },
          [Crepe.Feature.CodeMirror]: {
            languages: codeLanguages, searchPlaceholder: "搜索语言", noResultText: "没有匹配的语言",
            copyText: "复制", previewToggleText: (preview) => preview ? "编辑" : "隐藏预览",
          },
          [Crepe.Feature.Latex]: {
            katexOptions: { trust: false, strict: false, maxSize: 64, maxExpand: 512, throwOnError: false },
          },
        },
      });
      this.crepe = editor;
      editor.editor.config((ctx) => ctx.update(paragraphSchema.key, (original) => (ctx) => {
        const schema = original(ctx);
        return {
          ...schema,
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) => {
              // Empty list items and paragraphs are valid Markdown. Crepe's
              // HTML placeholder would otherwise trigger source preservation.
              if (node.content.size === 0) state.openNode("paragraph").closeNode();
              else schema.toMarkdown.runner(state, node);
            },
          },
        };
      }));
      editor.editor.config((ctx) => ctx.update(imageBlockSchema.key, (original) => (ctx) => {
        const schema = original(ctx);
        // Crepe normally stores a resize ratio in Markdown's alt text. Keep
        // standard image descriptions instead, so rich edits remain lossless.
        return {
          ...schema,
          attrs: { ...schema.attrs, alt: { default: "", validate: "string" } },
          parseDOM: [{
            tag: 'img[data-type="image-block"]',
            getAttrs: (dom) => ({
              src: dom.getAttribute("src") ?? "", alt: dom.getAttribute("alt") ?? "",
              caption: dom.getAttribute("title") ?? dom.getAttribute("caption") ?? "", ratio: 1,
            }),
          }],
          toDOM: (node) => ["img", {
            "data-type": "image-block", src: node.attrs.src,
            alt: node.attrs.alt, title: node.attrs.caption,
          }],
          parseMarkdown: {
            ...schema.parseMarkdown,
            runner: (state, node, type) => {
              state.addNode(type, { src: node.url ?? "", alt: node.alt ?? "", caption: node.title ?? "", ratio: 1 });
            },
          },
          toMarkdown: {
            ...schema.toMarkdown,
            runner: (state, node) => {
              state.openNode("paragraph");
              state.addNode("image", undefined, undefined, { url: node.attrs.src, alt: node.attrs.alt, title: node.attrs.caption });
              state.closeNode();
            },
          },
        };
      }));
      editor.editor.use($prose(() => new Plugin({
        props: {
          nodeViews: {
            math_inline: (node) => {
              const dom = document.createElement("span");
              const value = String(node.attrs.value ?? "");
              dom.dataset.type = "math_inline";
              dom.dataset.value = value;
              if (value.length > 16384) dom.textContent = value;
              else katex.render(value, dom, {
                trust: false, strict: false, maxSize: 64, maxExpand: 512, throwOnError: false,
              });
              return { dom, ignoreMutation: () => true };
            },
          },
        },
        view: () => ({
          update: (view, previous) => {
            if (!this.richReady || this.syncing || this.destroyed) return;
            if (view.state.doc !== previous.doc) {
              this.richChanged = true;
              if (!view.composing) this.flushSoon();
            }
            if (!view.state.selection.eq(previous.selection)) this.rememberPosition();
          },
        }),
      })));
      await editor.create();
      if (this.destroyed) { await editor.destroy(); return; }
      this.richReady = true;
      this.richBaseSource = initialSource;
      this.appliedRichSource = initialSource;
      this.richBaseMarkdown = editor.getMarkdown();
      editor.setReadonly(this.document.readOnly);
      this.view()?.dom.setAttribute("aria-label", "Markdown 正文");
      this.view()?.dom.setAttribute("spellcheck", "false");
      this.applySettings();
    })();
    try { await this.initialising; }
    finally { this.initialising = null; }
  }

  async show(focus = false): Promise<void> {
    const generation = ++this.showGeneration;
    if (this.destroyed) return;
    const requested = this.document.mode;
    const reason = sourceOnlyReason(this.document.content);
    const mode = requested === "rich" && reason ? "source" : requested;
    if (requested !== mode) this.document.mode = mode;
    if (this.mode !== mode) { this.rememberPosition(); this.flush(); }
    this.mode = mode;
    this.root.hidden = false;
    this.notice.hidden = !reason;
    this.notice.textContent = reason;
    this.richHost.hidden = mode !== "rich";
    this.sourceHost.hidden = mode !== "source";
    if (mode === "source") this.ensureSource();
    else {
      try { await this.ensureRich(); }
      catch (error) {
        this.document.mode = "source";
        this.mode = "source";
        this.richHost.hidden = true;
        this.sourceHost.hidden = false;
        this.ensureSource();
        this.notice.hidden = false;
        this.notice.textContent = "可视化编辑暂时无法加载，可以继续编辑源码。";
        this.controller.dialogs.error(String(error));
      }
    }
    if (this.destroyed || generation !== this.showGeneration || this.controller.activeId !== this.document.id) return;
    this.sync();
    const retainedPosition = this.positions.get(this.mode);
    const position = retainedPosition ?? { cursor: this.document.cursor, scroll: this.document.scrollTop };
    this.syncing = true;
    if (this.mode === "source" && this.source) {
      // Retained editors already own their complete selection, including ranges.
      // Only seed a cursor when opening this mode for the first time.
      if (!retainedPosition) {
        this.source.view.dispatch({ selection: { anchor: Math.min(position.cursor, this.source.view.state.doc.length) } });
      }
      this.source.view.scrollDOM.scrollTop = position.scroll;
    } else {
      const view = this.view();
      if (view) {
        if (!retainedPosition) {
          const pos = Math.max(0, Math.min(position.cursor, view.state.doc.content.size));
          view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
        }
        this.richHost.scrollTop = position.scroll;
      }
    }
    this.syncing = false;
    this.controller.emit("status", this.document.id);
    if (focus) this.focus();
    // WebView lays out newly attached/visible editors on the next frame.
    requestAnimationFrame(() => {
      if (generation !== this.showGeneration || this.destroyed || this.root.hidden) return;
      if (this.mode === "source" && this.source) this.source.view.scrollDOM.scrollTop = position.scroll;
      else this.richHost.scrollTop = position.scroll;
    });
  }
  hide(): void {
    this.showGeneration++;
    this.rememberPosition();
    this.flush();
    this.root.hidden = true;
  }
  flush(): void {
    this.flushSoon.cancel();
    if (this.syncing || this.destroyed) return;
    let next = this.lastSource;
    if (this.mode === "source" && this.sourceChanged && this.source) {
      next = this.source.doc.replace(/\r?\n/g, this.envelope.newline);
      this.sourceChanged = false;
      this.appliedSource = next;
    } else if (this.mode === "rich" && this.richChanged && this.crepe && !this.view()?.composing) {
      const markdown = this.crepe.getMarkdown();
      next = markdown === this.richBaseMarkdown ? this.richBaseSource : joinSource(this.envelope, markdown);
      this.richChanged = false;
      this.appliedRichSource = next;
    }
    if (next !== this.lastSource) {
      this.lastSource = next;
      this.envelope = splitSource(next);
      this.controller.changed(this.document.id, next);
    }
  }
  sync(): void {
    if (this.destroyed) return;
    const raw = this.document.content;
    if (this.mode === "rich" && sourceOnlyReason(raw)) {
      this.document.mode = "source";
      if (!this.root.hidden) void this.show();
      return;
    }
    this.syncing = true;
    try {
      if (this.mode === "source" && this.source && raw !== this.appliedSource) {
        this.source.syncDoc(raw);
        this.appliedSource = raw;
      }
      if (this.mode === "rich" && this.richReady && raw !== this.appliedRichSource) {
        const body = splitSource(raw).body;
        this.crepe!.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const parsed = ctx.get(parserCtx)(body);
          if (!parsed) throw new Error("无法解析 Markdown");
          if (!view.state.doc.eq(parsed)) {
            // One synchronisation transaction preserves this document's history.
            view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, parsed.content));
          }
        });
        this.richBaseSource = raw;
        this.richBaseMarkdown = this.crepe!.getMarkdown();
        this.appliedRichSource = raw;
      }
      this.lastSource = raw;
      this.envelope = splitSource(raw);
      this.sourceChanged = false;
      this.richChanged = false;
      this.syncReadOnly();
    } finally { this.syncing = false; }
  }
  syncReadOnly(): void {
    if (this.readOnlyApplied === this.document.readOnly) return;
    this.readOnlyApplied = this.document.readOnly;
    this.source?.setReadOnly(this.document.readOnly);
    this.crepe?.setReadonly(this.document.readOnly);
  }
  applySettings(): void {
    const s = this.controller.settings;
    this.root.style.setProperty("--editor-size", s.fontSize + "px");
    this.root.style.setProperty("--editor-leading", String(s.lineHeight));
    this.root.style.setProperty("--measure", ({ narrow: "620px", medium: "760px", wide: "920px", full: "100%" })[s.editorWidth]);
    this.root.style.setProperty("--editor-font", s.fontFamily === "system" ? "var(--font-reading)" : s.fontFamily);
    this.source?.applySettings(this.sourceSettings());
  }
  focus(): void {
    if (this.mode === "source") this.source?.focus();
    else this.view()?.focus();
  }
  async insertMarkdown(markdown: string): Promise<void> {
    if (this.document.readOnly) return;
    if (this.mode === "source") this.source?.replaceSelection(markdown);
    else { await this.ensureRich(); this.crepe?.editor.action(insert(markdown)); this.focus(); this.flush(); }
  }
  async insertImages(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const href = await this.controller.bridge.uploadImage(this.document.id, file);
        await this.insertMarkdown(`![${file.name.replace(/[\[\]\\]/g, "")}](${href})`);
      } catch (error) { this.controller.dialogs.error(String(error)); }
    }
  }
  async format(action: FormatAction): Promise<void> {
    if (this.document.readOnly) return;
    this.focus();
    if (this.mode === "source" && this.source) {
      if (/^h[1-6]$/.test(action) || action === "paragraph") {
        sourceCommands.heading(action === "paragraph" ? 0 : Number(action[1]))(this.source.view);
        return;
      }
      const key = ({ codeblock: "codeBlock", paragraph: "h0" } as Record<string, string>)[action] ?? action;
      const command = (sourceCommands as unknown as Record<string, (view: MarkdownEditor["view"]) => boolean>)[key];
      if (command) { command(this.source.view); return; }
    } else {
      const view = this.view();
      if (!view) return;
      const schema = view.state.schema;
      const mark = ({ bold: "strong", italic: "emphasis", strike: "strike_through", code: "inlineCode" } as Record<string, string>)[action];
      if (mark) { toggleMark(schema.marks[mark])(view.state, view.dispatch); return; }
      if (action === "undo") { proseUndo(view.state, view.dispatch); this.flush(); return; }
      if (action === "redo") { proseRedo(view.state, view.dispatch); this.flush(); return; }
      if (/^h[1-6]$/.test(action)) { setBlockType(schema.nodes.heading, { level: Number(action[1]) })(view.state, view.dispatch); return; }
      if (action === "paragraph") { setBlockType(schema.nodes.paragraph)(view.state, view.dispatch); return; }
      if (action === "quote") { wrapIn(schema.nodes.blockquote)(view.state, view.dispatch); return; }
      if (action === "bullet" || action === "ordered") {
        wrapInList(schema.nodes[action === "bullet" ? "bullet_list" : "ordered_list"])(view.state, view.dispatch);
        return;
      }
      if (action === "table") { this.crepe!.editor.action(callCommand(insertTableCommand.key, { row: 3, col: 2 })); return; }
    }
    if (action === "link") {
      const href = await prompt({ title: "插入链接", label: "链接地址", placeholder: "https://example.com",
        validate: (value) => /^(?:javascript|vbscript|data):/i.test(value) ? "不支持这个链接地址" : null });
      if (href) await this.insertMarkdown(`[链接](<${href.replace(/[<>\n\r]/g, "")}>)`);
      return;
    }
    const snippets: Partial<Record<FormatAction, string>> = {
      task: "- [ ] 待办事项", codeblock: "```\n\n```", table: "| 标题 | 标题 |\n| --- | --- |\n| 内容 | 内容 |\n",
      math: "$$\nE = mc^2\n$$", hr: "\n---\n", quote: "> ", bullet: "- ", ordered: "1. ",
    };
    if (snippets[action]) await this.insertMarkdown(snippets[action]!);
  }
  goToHeading(index: number): void {
    this.showGeneration++;
    if (this.mode === "source") {
      const envelope = splitSource(this.document.content);
      const headings = outlineOf(envelope.body);
      const offset = (envelope.prefix.match(/\n/g) ?? []).length;
      if (headings[index]) this.source?.goToLine(headings[index].line + offset);
      return;
    }
    const view = this.view();
    let count = 0;
    view?.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading" && count++ === index) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos + 1))).scrollIntoView());
        view.focus();
      }
    });
  }
  private matches(query: string): Match[] {
    if (!query) return [];
    let text = "";
    const positions: number[] = [];
    if (this.mode === "source" && this.source) {
      text = this.source.doc;
      for (let i = 0; i < text.length; i++) positions.push(i);
    } else {
      let previousEnd = -1;
      this.view()?.state.doc.descendants((node, pos) => {
        if (!node.isText) return;
        if (previousEnd !== pos) { text += "\n"; positions.push(pos); }
        const value = node.text ?? "";
        for (let i = 0; i < value.length; i++) positions.push(pos + i);
        text += value;
        previousEnd = pos + value.length;
      });
    }
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    const out: Match[] = [];
    for (let from = lower.indexOf(needle); from >= 0; from = lower.indexOf(needle, from + Math.max(1, needle.length))) {
      out.push({ from: positions[from], to: positions[from + needle.length - 1] + 1 });
    }
    return out;
  }
  find(query: string, backwards = false): { current: number; total: number } {
    this.showGeneration++;
    const matches = this.matches(query);
    if (!matches.length) return { current: 0, total: 0 };
    const cursor = this.mode === "source" ? this.source?.view.state.selection.main.to ?? 0 : this.view()?.state.selection.to ?? 0;
    let index = backwards ? matches.findLastIndex((match) => match.to < cursor) : matches.findIndex((match) => match.from >= cursor);
    if (index < 0) index = backwards ? matches.length - 1 : 0;
    const match = matches[index];
    if (this.mode === "source") this.source?.view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true });
    else {
      const view = this.view();
      if (view) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)).scrollIntoView());
    }
    return { current: index + 1, total: matches.length };
  }
  replace(query: string, replacement: string, all: boolean): number {
    if (this.document.readOnly) return 0;
    let matches = this.matches(query);
    if (!all) {
      const selection = this.mode === "source" ? this.source?.view.state.selection.main : this.view()?.state.selection;
      const selected = matches.find((match) => match.from === selection?.from && match.to === selection?.to);
      matches = selected ? [selected] : [];
    }
    if (this.mode === "source" && this.source) {
      this.source.view.dispatch({ changes: matches.map((match) => ({ ...match, insert: replacement })) });
    } else {
      const view = this.view();
      if (view && matches.length) {
        const tr = view.state.tr;
        for (const match of [...matches].reverse()) tr.insertText(replacement, match.from, match.to);
        view.dispatch(tr);
      }
    }
    this.flush();
    return matches.length;
  }
  destroy(): void {
    this.destroyed = true;
    this.flushSoon.cancel();
    this.removeFlusher();
    this.source?.destroy();
    if (this.richReady) void this.crepe?.destroy();
    this.root.remove();
  }
}
