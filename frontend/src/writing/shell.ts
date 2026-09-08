import { el, icon } from "../lib/dom";
import * as api from "../api";
import { installShortcuts, type ShortcutSpec } from "../shortcuts";
import { anchorRect, showMenu, type MenuEntry } from "../ui/menu";
import { confirm, openModal, prompt } from "../ui/modal";
import { createWindowControls, brandMark } from "../ui/windowcontrols";
import { DocumentEditor, type FormatAction } from "./editor";
import { WritingSidebar } from "./sidebar";
import { checkUpdates, showExport, showSettings, showShortcuts, showSyntax, showTrash } from "./dialogs";
import type { WritingController } from "./controller";
import { isDirty } from "./types";
import { countDocumentWords } from "./source";
import { splitSource } from "./source";
import { outlineOf } from "../lib/markdown";
import { resolveDocumentLink } from "./links";
import { WindowSetTitle } from "../../wailsjs/runtime/runtime";

export function mountWritingShell(root: HTMLElement, controller: WritingController): () => void {
  const run = (job: () => Promise<unknown>) => void job().catch((error) => controller.dialogs.error(String(error)));
  const editors = new Map<string, DocumentEditor>();
  const wordCounts = new Map<string, { content: string; count: number }>();
  const stage = el("main", { class: "writing-stage", "aria-label": "文档编辑区" });
  const title = el("div", { class: "writing-title" });
  const tabs = el("div", { class: "writing-tabs", role: "tablist", "aria-label": "打开的文档", hidden: true });
  const menuBar = el("nav", { class: "writing-menus", "aria-label": "主菜单" });
  const controls = createWindowControls();
  const titlebar = el("header", { class: "writing-titlebar", ondblclick: (event: MouseEvent) => {
    if (!(event.target as HTMLElement).closest("button, a, input")) void api.windowToggleMaximise();
  } }, brandMark("writing-mark"), menuBar, title, controls);
  const footerWords = el("span");
  const footerMode = el("button", { class: "status-mode", type: "button", onclick: () => toggleSource() });
  const footerZoom = el("button", { class: "status-zoom", type: "button", hidden: true,
    onclick: () => setZoom(100) });
  const footerSave = el("button", { class: "status-save", type: "button", onclick: () => run(() => controller.save()) });
  const footer = el("footer", { class: "writing-status", "aria-label": "文档状态" },
    footerWords, el("div", null, footerZoom, footerMode, footerSave));
  const empty = el("div", { class: "writing-empty" },
    el("button", { class: "btn", type: "button", onclick: () => run(() => controller.newDocument()) }, "新建文档"),
    el("button", { class: "btn", type: "button", onclick: () => run(() => controller.open()) }, "打开文件"));
  stage.append(empty);
  const alert = el("div", { class: "document-alert", hidden: true, role: "status" });
  const findInput = el("input", { class: "input", type: "text", placeholder: "查找", "aria-label": "查找文档" });
  const replaceInput = el("input", { class: "input", type: "text", placeholder: "替换为", "aria-label": "替换内容" });
  const findCount = el("span", { class: "find-count", "aria-live": "polite" });
  const findBar = el("div", { class: "writing-find", hidden: true });
  const replaceRow = el("div", { class: "writing-find__replace", hidden: true }, replaceInput,
    el("button", { class: "btn", type: "button", onclick: () => {
      const count = activeEditor()?.replace(findInput.value, replaceInput.value, false) ?? 0;
      if (count) find(false);
    } }, "替换"),
    el("button", { class: "btn", type: "button", onclick: () => {
      const count = activeEditor()?.replace(findInput.value, replaceInput.value, true) ?? 0;
      findCount.textContent = `已替换 ${count} 处`;
    } }, "全部替换"));
  findBar.append(el("div", { class: "writing-find__search" }, findInput, findCount,
    el("button", { class: "ibtn", type: "button", title: "上一个", "aria-label": "上一个匹配", onclick: () => find(true) }, icon("chevronUp", 14)),
    el("button", { class: "ibtn", type: "button", title: "下一个", "aria-label": "下一个匹配", onclick: () => find(false) }, icon("chevronDown", 14)),
    el("button", { class: "ibtn", type: "button", title: "关闭查找", "aria-label": "关闭查找", onclick: closeFind }, icon("close", 14))), replaceRow);
  findInput.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Enter") { event.preventDefault(); find(event.shiftKey); }
    if (event.key === "Escape") { event.stopPropagation(); closeFind(); }
  };
  findInput.oninput = () => { findCount.textContent = ""; };
  replaceInput.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") { event.stopPropagation(); closeFind(); }
  };
  const sidebar = new WritingSidebar(controller, (index) => {
    activeEditor()?.goToHeading(index);
    if (body.clientWidth < 720) body.classList.remove("is-drawer-open");
  }, () => { body.classList.remove("is-drawer-open"); });
  const editorArea = el("section", { class: "writing-editor" }, alert, findBar, stage);
  const resizer = el("div", { class: "writing-resizer", role: "separator", tabIndex: 0,
    "aria-label": "调整侧栏宽度", "aria-orientation": "vertical", "aria-valuemin": 200, "aria-valuemax": 360 });
  const backdrop = el("button", { class: "sidebar-backdrop", type: "button", "aria-label": "收起侧栏",
    onclick: () => { body.classList.remove("is-drawer-open"); } });
  const body = el("div", { class: "writing-body" }, sidebar.root, resizer, backdrop, editorArea);
  const shell = el("div", { class: "writing-shell" }, titlebar, tabs, body, footer);
  root.replaceChildren(shell);

  function activeEditor(): DocumentEditor | undefined { return controller.activeId ? editors.get(controller.activeId) : undefined; }
  function toggleSource(): void {
    const doc = controller.active;
    if (doc) controller.setMode(doc.id, doc.mode === "source" ? "rich" : "source");
  }
  function setZoom(zoom: number): void { run(() => controller.patchSettings({ zoom })); }
  function toggleSidebar(): void {
    if (body.clientWidth < 720) body.classList.toggle("is-drawer-open");
    else void controller.patchSettings({ sidebarHidden: !controller.settings.sidebarHidden });
  }
  function openSearch(): void {
    if (body.clientWidth < 720) body.classList.add("is-drawer-open");
    sidebar.focusSearch();
  }
  function openFind(replace = false): void {
    if (!controller.active) return;
    findBar.hidden = false;
    replaceRow.hidden = !replace;
    findInput.focus();
    findInput.select();
  }
  function closeFind(): void { findBar.hidden = true; activeEditor()?.focus(); }
  function find(backward: boolean): void {
    const result = activeEditor()?.find(findInput.value, backward);
    findCount.textContent = result?.total ? `${result.current} / ${result.total}` : "没有匹配";
  }
  function format(action: FormatAction): void { run(async () => { await activeEditor()?.format(action); }); }
  function insertImage(): void {
    const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: true });
    input.onchange = () => run(async () => { await activeEditor()?.insertImages(Array.from(input.files ?? [])); });
    input.click();
  }
  function rename(): void {
    const doc = controller.active;
    if (!doc?.path) { run(() => controller.save()); return; }
    run(async () => {
      const name = await prompt({ title: "重命名文件", label: "文件名", value: doc.name });
      if (name) await controller.rename(doc.id, /\.(?:md|markdown)$/i.test(name) ? name : name + ".md");
    });
  }
  const action = (label: string, job: () => void, shortcut?: string, disabled = false): MenuEntry => ({ label, run: job, shortcut, disabled });
  const formatting = (): MenuEntry[] => [
    { label: "标题", children: [
      action("正文", () => format("paragraph"), "Ctrl+0"),
      ...[1, 2, 3, 4, 5, 6].map((level) => action(`标题 ${level}`, () => format(`h${level}` as FormatAction), `Ctrl+${level}`)),
    ] },
    action("加粗", () => format("bold"), "Ctrl+B"), action("斜体", () => format("italic"), "Ctrl+I"),
    action("删除线", () => format("strike")), action("行内代码", () => format("code"), "Ctrl+E"), "separator",
    action("无序列表", () => format("bullet")), action("有序列表", () => format("ordered")),
    action("任务清单", () => format("task"), "Ctrl+Shift+L"), action("引用", () => format("quote")), "separator",
    action("链接", () => format("link"), "Ctrl+K"), action("图片", insertImage), action("表格", () => format("table")),
    action("代码块", () => format("codeblock")), action("公式", () => format("math")), action("分隔线", () => format("hr")),
  ];
  const menus: Record<string, () => MenuEntry[]> = {
    文件: () => [
      action("新建文档", () => run(() => controller.newDocument()), "Ctrl+N"),
      action("打开文件…", () => run(() => controller.open()), "Ctrl+O"),
      action("打开文件夹…", () => run(() => controller.openFolder()), "Ctrl+Shift+O"), "separator",
      action("保存", () => run(() => controller.save()), "Ctrl+S", !controller.active),
      action("另存为…", () => run(() => controller.save(undefined, true)), "Ctrl+Shift+S", !controller.active),
      action("全部保存", () => run(async () => { for (const doc of controller.documents) if (isDirty(doc) && !(await controller.save(doc.id))) break; }), undefined, !controller.documents.length),
      action("重命名…", rename, undefined, !controller.active), "separator",
      action("导出…", () => showExport(controller), "Ctrl+Shift+E", !controller.active),
      action("回收站", () => run(() => showTrash(controller))),
      action("关闭文档", () => { if (controller.activeId) run(() => controller.close(controller.activeId!)); }, "Ctrl+W", !controller.active),
      "separator", action("退出", () => run(() => controller.requestQuit())),
    ],
    编辑: () => [
      action("撤销", () => format("undo"), "Ctrl+Z"), action("重做", () => format("redo"), "Ctrl+Y"), "separator",
      action("剪切", () => { activeEditor()?.focus(); document.execCommand("cut"); }, "Ctrl+X"),
      action("复制", () => { activeEditor()?.focus(); document.execCommand("copy"); }, "Ctrl+C"),
      action("粘贴", () => run(async () => { const text = await navigator.clipboard.readText(); await activeEditor()?.insertMarkdown(text); }), "Ctrl+V"),
      "separator", action("查找…", () => openFind(), "Ctrl+F"), action("替换…", () => openFind(true), "Ctrl+H"),
      action("搜索文件夹…", openSearch, "Ctrl+Shift+F"),
    ],
    格式: formatting,
    视图: () => [
      action(controller.settings.sidebarHidden ? "显示侧栏" : "隐藏侧栏", toggleSidebar, "Ctrl+\\"),
      action("文件", () => { void controller.patchSettings({ sidebarMode: "files", sidebarHidden: false }); if (body.clientWidth < 720) body.classList.add("is-drawer-open"); }),
      action("文章大纲", () => { void controller.patchSettings({ sidebarMode: "outline", sidebarHidden: false }); if (body.clientWidth < 720) body.classList.add("is-drawer-open"); }),
      "separator", { label: "源码模式", icon: controller.active?.mode === "source" ? "check" : undefined, shortcut: "Ctrl+/", run: toggleSource, disabled: !controller.active },
      { label: "主题", children: ([["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]] as const).map(([theme, label]) => ({
        label, icon: controller.settings.theme === theme ? "check" : undefined, run: () => void controller.patchSettings({ theme }),
      })) },
      { label: `应用缩放 · ${controller.settings.zoom}%`, children: [
        ...[50, 75, 100, 125, 150, 175, 200].map((zoom) => ({
          label: zoom === 100 ? "100%（默认）" : `${zoom}%`,
          icon: controller.settings.zoom === zoom ? "check" as const : undefined,
          run: () => setZoom(zoom),
        })),
      ] },
      action("恢复 100% 缩放", () => setZoom(100), "Ctrl+Alt+0", controller.settings.zoom === 100),
      "separator", action("设置…", () => showSettings(controller), "Ctrl+,"),
    ],
    帮助: () => [
      action("Markdown 入门", showSyntax), action("快捷键", showShortcuts), "separator",
      action("检查更新…", () => run(() => checkUpdates())),
      action("关于巧记", () => openModal({ title: "巧记", width: 360, body: el("div", { class: "writing-about" },
        brandMark("about-mark"), el("p", null, "专注于文字的 Markdown 编辑器"), el("p", { class: "quiet-copy" }, "版本 " + controller.version),
        el("button", { class: "btn", type: "button", onclick: () => void api.openExternal("https://github.com/7788dev/qiaoji") }, "项目主页")) })),
    ],
  };
  const menuButtons: HTMLButtonElement[] = [];
  for (const [label, entries] of Object.entries(menus)) {
    const button = el("button", { class: "writing-menu", type: "button", "aria-haspopup": "menu",
      onmousedown: (event: MouseEvent) => event.preventDefault(),
      onclick: () => {
        const rect = anchorRect(button);
        showMenu(entries(), { x: rect.left, y: rect.bottom + 2 });
      } }, label);
    menuButtons.push(button);
    menuBar.append(button);
  }
  const sidebarToggle = el("button", { class: "ibtn writing-sidebar-toggle", type: "button", title: "显示或隐藏侧栏  Ctrl+\\", "aria-label": "显示或隐藏侧栏", onclick: toggleSidebar }, icon("sidebar", 15));
  titlebar.insertBefore(sidebarToggle, menuBar);

  function paintStatus(): void {
    const doc = controller.active;
    const name = doc?.name ?? "巧记";
    title.textContent = name;
    title.title = doc?.path || name;
    const windowTitle = (doc ? name + (isDirty(doc) ? " *" : "") + " — " : "") + "巧记";
    if (document.title !== windowTitle) {
      document.title = windowTitle;
      if ("go" in window) WindowSetTitle(windowTitle);
    }
    if (doc && wordCounts.get(doc.id)?.content !== doc.content) {
      wordCounts.set(doc.id, { content: doc.content, count: countDocumentWords(doc.content) });
    }
    footerWords.textContent = doc ? wordCounts.get(doc.id)!.count + " 字" : "";
    footerMode.textContent = doc?.mode === "source" ? "源码" : "可视化";
    footerMode.title = "切换可视化 / 源码  Ctrl+/";
    footerMode.hidden = !doc;
    footerSave.textContent = !doc ? "" : doc.saving ? "正在保存…" : doc.error ? "保存失败" :
      doc.missing ? "文件已移除" : doc.conflict ? "磁盘文件已更改" : isDirty(doc) ? "未保存 · Ctrl+S" : !doc.path ? "未命名文档" : doc.readOnly ? "只读" : "已保存";
    footerSave.classList.toggle("is-dirty", Boolean(doc && isDirty(doc)));
    footerSave.classList.toggle("is-error", Boolean(doc?.error || doc?.conflict || doc?.missing));
    for (const tab of Array.from(tabs.querySelectorAll<HTMLElement>(".writing-tab"))) {
      const item = controller.documents.find((entry) => entry.id === tab.dataset.id);
      tab.querySelector(".tab-dirty")?.classList.toggle("is-visible", Boolean(item && isDirty(item)));
    }
    alert.replaceChildren();
    alert.hidden = !doc?.conflict && !doc?.missing;
    if (doc?.conflict || doc?.missing) {
      alert.append(el("span", null, doc.missing ? "文件已被移动或删除，编辑内容仍保留在这里。" : "磁盘文件已更改，你的编辑仍保留在这里。"));
      if (doc.conflict) alert.append(el("button", { class: "btn", type: "button", onclick: () => run(async () => {
        if (isDirty(doc) && !(await confirm({ title: "重新加载文件", message: "放弃当前未保存编辑，读取磁盘上的内容？", confirmLabel: "重新加载" }))) return;
        await controller.reload(doc.id, doc.conflict!.revision);
      }) }, "重新加载"));
      alert.append(el("button", { class: "btn", type: "button", onclick: () => run(() => controller.save(doc.id, true)) }, "另存为"));
      if (doc.conflict) alert.append(el("button", { class: "btn", type: "button", onclick: () => run(async () => {
        const revision = doc.conflict?.revision;
        if (await confirm({ title: "覆盖磁盘文件", message: "用当前编辑内容覆盖磁盘版本？", confirmLabel: "覆盖", danger: true })) await controller.save(doc.id, false, true, revision);
      }) }, "覆盖磁盘"));
    }
  }
  function paintTabs(): void {
    tabs.hidden = controller.documents.length < 2;
    tabs.replaceChildren(...controller.documents.map((doc) => {
      const tab = el("div", { class: "writing-tab", role: "tab", tabIndex: 0, dataset: { id: doc.id }, title: doc.path || doc.name,
        onclick: () => controller.activate(doc.id), onkeydown: (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); controller.activate(doc.id); }
        } }, el("span", { class: "truncate" }, doc.name), el("span", { class: "tab-dirty", "aria-label": "未保存" }),
        el("button", { class: "tab-close", type: "button", title: "关闭文档", "aria-label": "关闭 " + doc.name, onclick: (event: MouseEvent) => {
          event.stopPropagation(); run(() => controller.close(doc.id));
        } }, icon("close", 11)));
      tab.classList.toggle("is-active", doc.id === controller.activeId);
      tab.setAttribute("aria-selected", String(doc.id === controller.activeId));
      return tab;
    }));
    for (const [id, editor] of editors) if (!controller.documents.some((doc) => doc.id === id)) { editor.destroy(); editors.delete(id); wordCounts.delete(id); }
    tabs.querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    paintStatus();
  }
  function paintActive(): void {
    const doc = controller.active;
    empty.hidden = Boolean(doc);
    for (const [id, editor] of editors) if (id !== doc?.id && !editor.root.hidden) editor.hide();
    if (doc) {
      let editor = editors.get(doc.id);
      if (!editor) { editor = new DocumentEditor(doc, controller); editors.set(doc.id, editor); stage.append(editor.root); }
      run(() => editor!.show(true));
    }
    paintTabs();
  }
  function paintSettings(): void {
    const s = controller.settings;
    const theme = s.theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : s.theme;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty("--ui-scale", String(s.zoom / 100));
    footerZoom.textContent = `${s.zoom}%`;
    footerZoom.hidden = s.zoom === 100;
    footerZoom.title = `应用缩放 ${s.zoom}%，点击恢复 100%  Ctrl+Alt+0`;
    footerZoom.setAttribute("aria-label", footerZoom.title);
    try { localStorage.setItem("qiaoji.theme", s.theme); } catch { /* Optional flash guard. */ }
    if ("go" in window) void api.applyTheme(theme);
    body.classList.toggle("is-sidebar-hidden", s.sidebarHidden);
    body.style.setProperty("--writing-sidebar-width", s.sidebarWidth + "px");
    resizer.setAttribute("aria-valuenow", String(s.sidebarWidth));
    for (const editor of editors.values()) editor.applySettings();
  }

  resizer.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    const start = event.clientX;
    const initial = controller.settings.sidebarWidth;
    let width = initial;
    const move = (next: PointerEvent) => {
      width = Math.round(Math.max(200, Math.min(360, initial + (next.clientX - start) / (controller.settings.zoom / 100))));
      body.style.setProperty("--writing-sidebar-width", width + "px");
    };
    const end = () => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
      void controller.patchSettings({ sidebarWidth: width });
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  };
  resizer.onkeydown = (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const sidebarWidth = Math.max(200, Math.min(360, controller.settings.sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16)));
    void controller.patchSettings({ sidebarWidth });
  };
  const inDocument = (event: KeyboardEvent) => Boolean((event.target as Element | null)?.closest(".ProseMirror, .writing-source .cm-content"));
  const shortcuts: ShortcutSpec[] = [
    { key: "n", ctrl: true, run: () => run(() => controller.newDocument()) },
    { key: "o", ctrl: true, run: () => run(() => controller.open()) },
    { key: "o", ctrl: true, shift: true, run: () => run(() => controller.openFolder()) },
    { key: "s", ctrl: true, run: () => run(() => controller.save()) },
    { key: "s", ctrl: true, shift: true, run: () => run(() => controller.save(undefined, true)) },
    { key: "w", ctrl: true, run: () => { if (controller.activeId) run(() => controller.close(controller.activeId!)); } },
    { key: "f", ctrl: true, run: () => openFind() }, { key: "h", ctrl: true, run: () => openFind(true) },
    { key: "f", ctrl: true, shift: true, run: openSearch },
    { key: "/", ctrl: true, run: toggleSource }, { key: "\\", ctrl: true, run: toggleSidebar },
    { key: ",", ctrl: true, run: () => showSettings(controller) },
    { key: "0", ctrl: true, alt: true, run: () => setZoom(100) },
    { key: "e", ctrl: true, shift: true, run: () => showExport(controller) },
    ...([["b", "bold"], ["i", "italic"], ["e", "code"], ["k", "link"]] as const).map(([key, command]) => ({ key, ctrl: true, when: inDocument, run: () => format(command) })),
    { key: "l", ctrl: true, shift: true, when: inDocument, run: () => format("task") },
    ...[0, 1, 2, 3, 4, 5, 6].map((level) => ({ key: String(level), ctrl: true, when: inDocument, run: () => format(level ? `h${level}` as FormatAction : "paragraph") })),
    ...[false, true].map((shift) => ({ key: "Tab", ctrl: true, shift, run: () => {
      const docs = controller.documents;
      if (!docs.length) return;
      const index = docs.findIndex((doc) => doc.id === controller.activeId);
      controller.activate(docs[(index + (shift ? -1 : 1) + docs.length) % docs.length].id);
    } })),
    { key: "f", alt: true, run: () => menuButtons[0].click() },
  ];
  const uninstall = installShortcuts(shortcuts, () => {
    if (!findBar.hidden) { closeFind(); return true; }
    if (body.classList.contains("is-drawer-open")) { body.classList.remove("is-drawer-open"); return true; }
    return false;
  });
  const unsubscribe = controller.subscribe((kind, id) => {
    if (kind === "active") { paintActive(); return; }
    if (kind === "documents") { paintTabs(); return; }
    if (kind === "content") { if (id) editors.get(id)?.sync(); paintStatus(); }
    if (kind === "status") { if (id) editors.get(id)?.syncReadOnly(); paintStatus(); }
    if (kind === "settings") paintSettings();
  });
  const modeChanged = () => { if (controller.settings.theme === "system") paintSettings(); };
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");
  systemTheme.addEventListener("change", modeChanged);
  const checkDisk = () => { if (!document.hidden) void controller.checkDisk(); };
  window.addEventListener("focus", checkDisk);
  const interval = window.setInterval(checkDisk, 2500);
  const updateTimer = window.setTimeout(() => {
    if ("go" in window && controller.settings.autoUpdate) void checkUpdates(true);
  }, 3000);
  const backend: (() => void)[] = [];
  if ("go" in window) backend.push(
    api.onBackend("vault:delta", (payload) => {
      const change = payload as { structure?: boolean } | undefined;
      if (change?.structure) controller.emit("folder");
      checkDisk();
    }),
    api.onBackend("window:focus", checkDisk),
    api.onBackend("tray:new-note", () => run(() => controller.newDocument())),
    api.onBackend("app:before-close", (payload) => {
      if ((payload as { quitting?: boolean } | undefined)?.quitting === false) { void controller.persistSession(); return; }
      run(() => controller.requestQuit());
    }),
  );
  stage.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showMenu([
      action("撤销", () => format("undo"), "Ctrl+Z"), action("重做", () => format("redo"), "Ctrl+Y"), "separator",
      { label: "格式", children: formatting() }, action("插入图片", insertImage), "separator",
      action("查找", () => openFind(), "Ctrl+F"), action("源码模式", toggleSource, "Ctrl+/"),
    ], { x: event.clientX, y: event.clientY });
  });
  const followLink = (event: MouseEvent) => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>(".milkdown a[href], .milkdown-link-preview a[href]");
    if (!anchor) return;
    event.preventDefault();
    if (anchor.closest(".ProseMirror") && !event.ctrlKey && !event.metaKey) return;
    const doc = controller.active;
    if (!doc) return;
    const link = resolveDocumentLink(doc.path, anchor.getAttribute("href") ?? "");
    if (!link) return;
    run(async () => {
      if (link.kind === "external") { await api.openExternal(link.href); return; }
      if (link.kind === "document") {
        const opened = await controller.open(link.path);
        if (!opened) return;
        await editors.get(opened.id)?.show();
      }
      if (link.anchor) {
        const headings = outlineOf(splitSource(controller.active?.content ?? "").body);
        const index = headings.findIndex((heading) => heading.slug === link.anchor);
        if (index >= 0) activeEditor()?.goToHeading(index);
      }
    });
  };
  document.addEventListener("click", followLink, { capture: true });
  paintSettings();
  paintActive();
  return () => {
    clearInterval(interval);
    clearTimeout(updateTimer);
    uninstall(); unsubscribe(); sidebar.destroy(); controls.destroy();
    window.removeEventListener("focus", checkDisk);
    document.removeEventListener("click", followLink, { capture: true });
    systemTheme.removeEventListener("change", modeChanged);
    for (const off of backend) off();
    for (const editor of editors.values()) editor.destroy();
    controller.dispose();
  };
}
