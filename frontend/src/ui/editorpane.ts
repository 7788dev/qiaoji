import * as actions from "../actions";
import * as api from "../api";
import { MarkdownEditor, commands, insertSnippet } from "../lib/editor";
import { debounce, el, icon, on } from "../lib/dom";
import {
  modulesReadyFor,
  outlineOf,
  preloadFor,
  render,
  type OutlineEntry,
} from "../lib/markdown";
import {
  documentTemplates,
  snippetBody,
  snippetGroups,
  type SnippetGroup,
} from "../lib/templates";
import { activeTab, patchTab, state, subscribe } from "../store";
import { anchorRect, showMenu, type MenuEntry } from "./menu";
import { notify, reportError } from "./toast";

export interface EditorPaneHandlers {
  onCursor: (line: number, column: number, selected: number) => void;
}

export interface EditorPane {
  root: HTMLElement;
  editor: MarkdownEditor;
  destroy: () => void;
  toggleMode: () => void;
  setMode: (mode: "edit" | "preview") => void;
  showOutline: (anchor: HTMLElement) => void;
  focus: () => void;
  currentHtml: () => Promise<{ html: string; hasMath: boolean }>;
}

export function createEditorPane(handlers: EditorPaneHandlers): EditorPane {
  const editorHost = el("div", { class: "stage-inner", dataset: { width: "medium" } });
  const preview = el("article", { class: "preview scroll" });
  const previewInner = el("div", { class: "preview__inner" });
  preview.appendChild(previewInner);
  preview.hidden = true;

  const emptyState = el(
    "div",
    { class: "empty" },
    el("div", { class: "empty__icon" }, icon("note", 22)),
    el("div", { class: "empty__title" }, "没有打开的笔记"),
    el("div", { class: "empty__hint" }, "从左侧选择一篇笔记，或者按 Ctrl+N 新建一篇。"),
    el(
      "button",
      { class: "btn btn--primary", type: "button", onclick: () => void actions.newNote() },
      icon("plus", 14),
      "新建笔记",
    ),
  );

  const stage = el("div", { class: "pane__stage" }, editorHost, preview, emptyState);
  const toolbar = el("div", { class: "pane__toolbar" });
  const root = el("section", { class: "pane", "aria-label": "编辑区" }, toolbar, stage);

  /* ------------------------------------------------------------ editor */

  const editor = new MarkdownEditor(
    {
      parent: editorHost,
      doc: "",
      onChange: (doc) => {
        actions.markDirty(doc);
        ensureModules(doc);
        if (currentMode() === "preview") schedulePreview();
      },
      onCursor: handlers.onCursor,
      onSave: () => void actions.saveActive(),
      onImages: (files, from, to) => insertImages(files, from, to),
      onScroll: (top) => {
        const tab = activeTab();
        if (tab) tab.scrollTop = top;
      },
    },
    editorSettings(),
  );

  const unregisterEditor = actions.registerEditor(editor);
  const removeContextMenu = installContextMenu(editor);

  function insertImages(files: File[], from: number, to: number): void {
    const tab = activeTab();
    if (!tab) return;

    const entries = files.map((file, index) => {
      const id =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2)}`;
      const alt =
        file.name.replace(/\.[^.]+$/, "").replace(/[[\]\\]/g, "").trim() || "图片";
      return {
        file,
        alt,
        placeholder: `![正在保存 ${alt}…](qiaoji-upload-${id})`,
      };
    });

    const before = editor.doc.slice(0, from);
    const after = editor.doc.slice(to);
    const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
    editor.replaceRange(
      from,
      to,
      prefix + entries.map((entry) => entry.placeholder).join("\n") + suffix,
    );

    for (const entry of entries) {
      void (async () => {
        try {
          const bytes = Array.from(new Uint8Array(await entry.file.arrayBuffer()));
          const current = state.tabs.find((candidate) => candidate.id === tab.id);
          if (!current) return;
          const relative = await api.saveAsset(
            current.path,
            entry.file.name || `${entry.alt}.png`,
            bytes,
          );
          actions.replaceUploadPlaceholder(
            tab.id,
            entry.placeholder,
            `![${entry.alt}](<${relative}>)`,
          );
        } catch (err) {
          actions.replaceUploadPlaceholder(
            tab.id,
            entry.placeholder,
            `**图片保存失败：${entry.alt}**`,
          );
          reportError("保存图片", err);
        }
      })();
    }
  }

  /**
   * Picks up maths or code typed into a note that previously had neither.
   * Debounced because it runs on the keystroke path; both loaders return
   * immediately once their module is in memory.
   */
  const ensureModules = debounce((doc: string) => {
    if (modulesReadyFor(doc)) return;
    void preloadFor(doc).then(() => editor.refreshMath());
  }, 400);

  function editorSettings() {
    const s = state.settings;
    return {
      fontSize: s.fontSize,
      lineHeight: s.lineHeight,
      tabSize: s.tabSize,
      showLineNumbers: s.showLineNumbers,
      autoPairing: s.autoPairing,
      width: s.editorWidth,
    };
  }

  /* ------------------------------------------------------------ toolbar */

  interface ToolButton {
    icon: string;
    title: string;
    run: () => void;
  }

  function buildToolbar(): void {
    const groups: (ToolButton | "sep")[] = [
      { icon: "heading", title: "标题  Ctrl+1 / 2 / 3", run: () => headingMenu() },
      "sep",
      { icon: "bold", title: "加粗  Ctrl+B", run: () => editor.run(commands.bold) },
      { icon: "italic", title: "斜体  Ctrl+I", run: () => editor.run(commands.italic) },
      {
        icon: "strikethrough",
        title: "删除线  Ctrl+Shift+X",
        run: () => editor.run(commands.strike),
      },
      { icon: "codeTag", title: "行内代码  Ctrl+E", run: () => editor.run(commands.code) },
      "sep",
      {
        icon: "plus",
        title: "插入内容与模板（也可在正文中点右键）",
        run: () => openInsertMenu(),
      },
      "sep",
      { icon: "bulletList", title: "无序列表", run: () => editor.run(commands.bullet) },
      { icon: "checkSquare", title: "任务项  Ctrl+Shift+L", run: () => editor.run(commands.task) },
      { icon: "quote", title: "引用", run: () => editor.run(commands.quote) },
      { icon: "external", title: "插入链接  Ctrl+K", run: () => editor.run(commands.link) },
      { icon: "table", title: "插入表格", run: () => editor.run(commands.table) },
      "sep",
      { icon: "star", title: "收藏 / 取消收藏", run: () => toggleFavorite() },
    ];

    toolbar.replaceChildren(
      ...groups.map((entry) =>
        entry === "sep"
          ? el("span", { class: "toolbar-sep" })
          : el(
              "button",
              {
                class: "ibtn",
                type: "button",
                title: entry.title,
                "aria-label": entry.title,
                onclick: entry.run,
                dataset: entry.icon === "plus" ? { insert: "1" } : undefined,
              },
              icon(entry.icon, 15),
            ),
      ),
      el("div", { class: "spacer" }),
      el(
        "button",
        {
          class: "ibtn",
          type: "button",
          title: "在资源管理器中显示",
          onclick: () => {
            const tab = activeTab();
            if (tab) void api.revealInExplorer(tab.path);
          },
        },
        icon("folderOpen", 15),
      ),
    );
  }

  /** Opens the insert menu anchored under its toolbar button. */
  function openInsertMenu(): void {
    const button = toolbar.querySelector<HTMLElement>('[data-insert="1"]');
    const rect = button ? anchorRect(button) : undefined;
    showMenu(insertEntries(editor), {
      x: rect?.left ?? 200,
      y: (rect?.bottom ?? 100) + 4,
    });
  }

  function headingMenu(): void {
    const anchor = toolbar.querySelector<HTMLElement>("button");
    const rect = anchor ? anchorRect(anchor) : undefined;
    showMenu(
      [1, 2, 3, 4].map((level) => ({
        label: `${"#".repeat(level)} 标题 ${level}`,
        run: () => editor.run(commands.heading(level)),
      })).concat([{ label: "清除标题", run: () => editor.run(commands.heading(0)) }]),
      { x: rect?.left ?? 100, y: (rect?.bottom ?? 100) + 4 },
    );
  }

  function toggleFavorite(): void {
    const tab = activeTab();
    if (tab) void actions.toggleFavorite(tab.path);
  }

  buildToolbar();

  /* ------------------------------------------------------------ preview */

  const schedulePreview = debounce(() => void paintPreview(), 140);

  async function paintPreview(): Promise<void> {
    const tab = activeTab();
    if (!tab) return;
    const source = editor.doc;

    previewInner.innerHTML = render(source, tab.path).html;

    // Maths and highlighting arrive asynchronously the first time they are
    // needed; re-render once they are in so the output is complete. Once both
    // modules are in memory the second pass would render the same HTML twice.
    if (modulesReadyFor(source)) return;
    await preloadFor(source);
    if (activeTab()?.id !== tab.id) return;
    previewInner.innerHTML = render(editor.doc, tab.path).html;
  }

  // Links inside the preview must not navigate the WebView away from the app.
  const removePreviewClick = on(previewInner, "click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("a");
    if (!target) return;
    ev.preventDefault();
    const external = target.dataset.external;
    if (external) {
      void api.openExternal(external);
      return;
    }
    const anchor = target.dataset.anchor;
    if (anchor) {
      previewInner.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  });

  /* ------------------------------------------------------------ mode */

  function currentMode(): "edit" | "preview" {
    return activeTab()?.mode ?? "edit";
  }

  let appliedMode: "edit" | "preview" | null = null;

  /**
   * Shows the editor or the preview.
   *
   * Focus only moves when the pane actually switched. Grabbing it on every
   * call meant a background autosave or a tag edit could pull the caret out of
   * whatever dialog or input the user was typing in.
   */
  function applyMode(options: { focus?: boolean } = {}): void {
    const tab = activeTab();
    const mode = tab?.mode ?? "edit";
    const previewing = mode === "preview";
    const leftPreview = appliedMode === "preview" && mode === "edit";
    appliedMode = tab ? mode : null;

    editorHost.hidden = !tab || previewing;
    preview.hidden = !tab || !previewing;
    emptyState.hidden = Boolean(tab);
    toolbar.hidden = !tab || previewing;

    if (previewing) {
      void paintPreview();
      return;
    }
    // Coming back from preview puts the caret back where the user was reading.
    // Everything else leaves focus alone; whoever changed the tab decides.
    if (tab && (options.focus ?? leftPreview)) editor.focus();
  }

  function setMode(mode: "edit" | "preview"): void {
    const tab = activeTab();
    if (!tab || tab.mode === mode) return;
    patchTab(tab.id, { mode });
  }

  function toggleMode(): void {
    setMode(currentMode() === "edit" ? "preview" : "edit");
  }

  /* ------------------------------------------------------------ outline */

  function showOutline(anchor: HTMLElement): void {
    const tab = activeTab();
    if (!tab) return;
    const entries: OutlineEntry[] = outlineOf(editor.doc);
    const rect = anchorRect(anchor);

    if (entries.length === 0) {
      showMenu([{ label: "这篇笔记还没有标题", disabled: true }], {
        x: rect.right - 200,
        y: rect.bottom + 4,
      });
      return;
    }

    showMenu(
      entries.map((entry) => ({
        // Indentation communicates depth without a nested menu.
        label: `${"　".repeat(Math.max(0, entry.level - 1))}${entry.text}`,
        run: () => {
          if (currentMode() === "preview") {
            previewInner
              .querySelector(`#${CSS.escape(entry.slug)}`)
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          } else {
            editor.goToLine(entry.line);
          }
        },
      })),
      { x: rect.right - 240, y: rect.bottom + 4 },
    );
  }

  /* ------------------------------------------------------------ tab sync */

  let loadedTabId: string | null = null;

  function syncActiveTab(): void {
    const tab = activeTab();
    if (!tab) {
      loadedTabId = null;
      appliedMode = null;
      editor.loadDoc("", 0, 0);
      applyMode();
      return;
    }
    if (tab.id !== loadedTabId) {
      loadedTabId = tab.id;
      editor.loadDoc(tab.content, tab.cursor, tab.scrollTop);
      // Warm the optional modules, then repaint: KaTeX arrives after the first
      // render, and the formulas would otherwise stay as placeholder text.
      void preloadFor(tab.content).then(() => {
        if (activeTab()?.id === tab.id) editor.refreshMath();
      });
    }
    applyMode();
  }

  function applyAppearance(): void {
    const s = state.settings;
    editorHost.dataset.width = s.editorWidth;
    preview.style.setProperty("--measure", widthValue(s.editorWidth));
    preview.style.setProperty("--reading-size", `${s.fontSize + 1}px`);
    preview.style.setProperty("--reading-leading", String(s.lineHeight));
    editor.applySettings(editorSettings());
  }

  function widthValue(width: string): string {
    switch (width) {
      case "narrow":
        return "600px";
      case "wide":
        return "900px";
      case "full":
        return "none";
      default:
        return "720px";
    }
  }

  const unsubscribeActive = subscribe(["activeTabId"], syncActiveTab);
  const unsubscribeTabs = subscribe(["tabs"], () => {
    // A mode flip lives on the tab, so react to it without reloading the doc.
    const tab = activeTab();
    if (tab && tab.id === loadedTabId) applyMode();
  });
  const unsubscribeSettings = subscribe(["settings"], applyAppearance);

  applyAppearance();
  syncActiveTab();

  return {
    root,
    editor,
    destroy: () => {
      unsubscribeActive();
      unsubscribeTabs();
      unsubscribeSettings();
      ensureModules.cancel();
      schedulePreview.cancel();
      removePreviewClick();
      removeContextMenu();
      unregisterEditor();
      editor.destroy();
    },
    toggleMode,
    setMode,
    showOutline,
    focus: () => {
      if (currentMode() === "preview") preview.focus();
      else editor.focus();
    },
    currentHtml: async () => {
      const source = editor.doc;
      await preloadFor(source);
      const result = render(source);
      return { html: result.html, hasMath: result.hasMath };
    },
  };
}

/* ---------------------------------------------------------------- context menu */

function snippetItems(editor: MarkdownEditor, group: SnippetGroup): MenuEntry[] {
  return group.items.map((snippet) => ({
    label: snippet.label,
    icon: snippet.icon,
    run: () => editor.run(insertSnippet(snippetBody(snippet), snippet.block)),
  }));
}

/** The insert and template branches, shared by the toolbar and right-click. */
function insertEntries(editor: MarkdownEditor): MenuEntry[] {
  return [
    ...snippetGroups.map((group) => ({
      label: group.label,
      icon: group.icon,
      children: snippetItems(editor, group),
    })),
    "separator",
    {
      label: documentTemplates.label,
      icon: documentTemplates.icon,
      children: snippetItems(editor, documentTemplates),
    },
  ];
}

/**
 * Right-click menu for the editor. The native WebView2 menu is disabled, so
 * this is the only context menu the editor has: it carries the clipboard
 * actions people expect plus the snippet and template inserters.
 */
function installContextMenu(editor: MarkdownEditor): () => void {
  return on(editor.view.dom, "contextmenu", (ev) => {
    const event = ev as MouseEvent;
    event.preventDefault();

    // Right-clicking outside the selection should act on the word under the
    // pointer, matching every other editor.
    if (!editor.hasSelection) {
      editor.placeCaretAt(event.clientX, event.clientY);
    }
    const selection = editor.selectedText;
    const hasSelection = selection.length > 0;

    const entries: MenuEntry[] = [
      {
        label: "剪切",
        icon: "close",
        shortcut: "Ctrl+X",
        disabled: !hasSelection,
        run: () => {
          // The text is only removed once the clipboard actually has it, and a
          // refusal is reported as a clipboard problem rather than surfacing
          // as the generic unhandled-rejection toast.
          navigator.clipboard.writeText(selection).then(
            () => editor.replaceSelection(""),
            (err: unknown) => reportError("剪切", err),
          );
        },
      },
      {
        label: "复制",
        icon: "copy",
        shortcut: "Ctrl+C",
        disabled: !hasSelection,
        run: () => {
          navigator.clipboard
            .writeText(selection)
            .catch((err: unknown) => reportError("复制", err));
        },
      },
      {
        label: "粘贴",
        icon: "file",
        shortcut: "Ctrl+V",
        run: () => {
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) editor.replaceSelection(text);
            })
            .catch(() => notify.info("请使用 Ctrl+V 粘贴"));
        },
      },
      "separator",
      { label: "插入", icon: "plus", children: insertEntries(editor) },
      "separator",
      {
        label: "格式",
        icon: "bold",
        children: [
          { label: "加粗", icon: "bold", shortcut: "Ctrl+B", run: () => editor.run(commands.bold) },
          { label: "斜体", icon: "italic", shortcut: "Ctrl+I", run: () => editor.run(commands.italic) },
          {
            label: "删除线",
            icon: "strikethrough",
            run: () => editor.run(commands.strike),
          },
          {
            label: "行内代码",
            icon: "codeTag",
            shortcut: "Ctrl+E",
            run: () => editor.run(commands.code),
          },
          "separator",
          { label: "转为引用", icon: "quote", run: () => editor.run(commands.quote) },
          { label: "转为列表", icon: "bulletList", run: () => editor.run(commands.bullet) },
          { label: "转为任务项", icon: "checkSquare", run: () => editor.run(commands.task) },
          "separator",
          { label: "清除标题", icon: "minus", run: () => editor.run(commands.heading(0)) },
        ],
      },
      "separator",
      { label: "撤销", icon: "restore", shortcut: "Ctrl+Z", run: () => editor.run(commands.undo) },
      { label: "重做", icon: "refresh", shortcut: "Ctrl+Y", run: () => editor.run(commands.redo) },
    ];

    showMenu(entries, { x: event.clientX, y: event.clientY });
  });
}

/** Keeps the document title in step with the active note. */
export function bindDocumentTitle(): () => void {
  let shown = "";
  const paint = () => {
    const tab = activeTab();
    const next = tab ? `${actions.tabTitle(tab)} — 巧记` : "巧记";
    // Assigning document.title is a window-manager round trip on Windows, so
    // it is worth checking before writing it on every keystroke.
    if (next === shown) return;
    shown = next;
    document.title = next;
  };
  const unsubscribe = subscribe(["activeTabId", "tabs", "docRevision"], paint);
  paint();
  return unsubscribe;
}
