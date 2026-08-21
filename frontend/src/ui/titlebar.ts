import * as actions from "../actions";
import * as api from "../api";
import markUrl from "../assets/mark.png";
import {
  disposableElement,
  el,
  icon,
  on,
  type DisposableHTMLElement,
} from "../lib/dom";
import { isDirty, state, subscribe } from "../store";
import type { SortBy, Tab } from "../types";
import { anchorRect, showMenu, type MenuEntry } from "./menu";

export interface WorkspacebarHandlers {
  newNote: () => void;
  openSearch: () => void;
  toggleMode: () => void;
  toggleSidebar: () => void;
  toggleList: () => void;
  toggleProperties: () => void;
  openOutline: (anchor: HTMLElement) => void;
  openEditorActions: (anchor: HTMLElement) => void;
  refreshPreview: () => void;
  openExport: () => void;
  openTags: () => void;
  openTrash: () => void;
  openSettings: () => void;
  openPalette: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const TAB_BUDGET = 142;
const OVERFLOW_BUDGET = 34;

export function brandMark(className: string): HTMLElement {
  return el("img", {
    class: className,
    src: markUrl,
    alt: "巧记",
    draggable: false,
  });
}

function windowGlyph(kind: "min" | "max" | "restore" | "close"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 10 10");
  svg.setAttribute("width", "10");
  svg.setAttribute("height", "10");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1");
  svg.setAttribute("aria-hidden", "true");

  const paths: Record<typeof kind, string[]> = {
    min: ["M0 5.5h10"],
    max: ["M0.5 0.5h9v9h-9z"],
    restore: ["M2.5 0.5h7v7h-7z", "M0.5 2.5h7v7h-7z"],
    close: ["M0.5 0.5l9 9", "M9.5 0.5l-9 9"],
  };
  for (const d of paths[kind]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export function createWindowControls(): DisposableHTMLElement {
  let destroyed = false;
  const maxButton = el("button", {
    class: "wbtn",
    type: "button",
    title: "最大化",
    "aria-label": "最大化",
    onclick: () => void api.windowToggleMaximise().then(paintMaxButton),
  });

  async function paintMaxButton(): Promise<void> {
    const maximised = await api.windowIsMaximised();
    if (destroyed) return;
    maxButton.replaceChildren(windowGlyph(maximised ? "restore" : "max"));
    maxButton.title = maximised ? "向下还原" : "最大化";
  }
  void paintMaxButton();
  const removeResize = on(window, "resize", () => void paintMaxButton());

  const root = el(
    "div",
    { class: "workspacebar__controls" },
    el(
      "button",
      {
        class: "wbtn",
        type: "button",
        title: "最小化",
        "aria-label": "最小化",
        onclick: () => void api.windowMinimise(),
      },
      windowGlyph("min"),
    ),
    maxButton,
    el(
      "button",
      {
        class: "wbtn wbtn--close",
        type: "button",
        title: "关闭",
        "aria-label": "关闭",
        onclick: () => void api.windowClose(),
      },
      windowGlyph("close"),
    ),
  );
  return disposableElement(root, () => {
    destroyed = true;
    removeResize();
  });
}

function iconButton(name: string, title: string, run: () => void): HTMLElement {
  return el(
    "button",
    {
      class: "ibtn workspacebar__action",
      type: "button",
      title,
      "aria-label": title,
      onclick: run,
    },
    icon(name, 15),
  );
}

interface TabNode {
  root: HTMLElement;
  dot: HTMLElement;
  label: HTMLElement;
  close: HTMLElement;
  title: string;
}

export function createWorkspacebar(handlers: WorkspacebarHandlers): DisposableHTMLElement {
  const controls = createWindowControls();
  const strip = el("div", { class: "workspacebar__strip", role: "tablist" });
  const tabArea = el("div", { class: "workspacebar__tabs" }, strip);
  const hiddenTabIds = new Set<string>();

  const overflowButton = el(
    "button",
    {
      class: "workspacebar__overflow",
      type: "button",
      title: "更多文件",
      "aria-label": "更多文件",
      hidden: true,
    },
    icon("more", 14),
    el("span", { class: "workspacebar__overflow-count" }),
  );
  tabArea.appendChild(overflowButton);

  const modeButton = iconButton("eye", "预览  Ctrl+P", handlers.toggleMode);
  const propertiesButton = iconButton("info", "属性  Ctrl+Shift+I", handlers.toggleProperties);
  const moreButton = iconButton("more", "更多操作", () => openMoreMenu());

  const bar = el(
    "header",
    {
      class: "workspacebar",
      ondblclick: (ev: MouseEvent) => {
        // Match a native title bar: double-clicking brand or unused tab-strip
        // space toggles maximise, while tabs and toolbar buttons keep their
        // own double-click behaviour.
        const target = ev.target as HTMLElement;
        if (target.closest("button, input, select, textarea, a, .workspacebar__strip")) return;
        void api.windowToggleMaximise();
      },
    },
    el(
      "div",
      { class: "workspacebar__brand" },
      brandMark("workspacebar__mark"),
      el("span", { class: "workspacebar__title" }, "巧记"),
    ),
    tabArea,
    el(
      "div",
      { class: "workspacebar__actions" },
      iconButton("search", "全局搜索  Ctrl+Shift+F", handlers.openSearch),
      modeButton,
      propertiesButton,
      moreButton,
    ),
    controls,
  );

  function openMoreMenu(): void {
    const sortEntries: MenuEntry[] = [
      ["updated", "修改时间"],
      ["created", "创建时间"],
      ["title", "标题"],
    ].map(([value, label]) => ({
      label,
      icon: state.sortBy === value ? "check" : undefined,
      run: () => actions.setSortBy(value as SortBy),
    }));

    const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
    const rect = anchorRect(moreButton);
    showMenu(
      [
        { label: "新建笔记", icon: "plus", shortcut: "Ctrl+N", run: handlers.newNote },
        {
          label: "编辑操作",
          icon: "pencil",
          disabled: !tab,
          run: () => handlers.openEditorActions(moreButton),
        },
        {
          label: "文章大纲",
          icon: "list",
          disabled: !tab,
          run: () => handlers.openOutline(moreButton),
        },
        {
          label: "刷新预览",
          icon: "refresh",
          disabled: !tab || tab.mode !== "preview",
          run: handlers.refreshPreview,
        },
        "separator",
        {
          label: state.sidebarVisible ? "隐藏侧栏" : "显示侧栏",
          icon: "sidebar",
          shortcut: "Ctrl+\\",
          run: handlers.toggleSidebar,
        },
        {
          label: state.listVisible ? "隐藏笔记列表" : "显示笔记列表",
          icon: "columns",
          run: handlers.toggleList,
        },
        {
          label: state.propertiesVisible ? "隐藏属性" : "显示属性",
          icon: "info",
          shortcut: "Ctrl+Shift+I",
          run: handlers.toggleProperties,
        },
        {
          label: state.listView === "list" ? "网格视图" : "列表视图",
          icon: state.listView === "list" ? "grid" : "list",
          run: () => actions.setListView(state.listView === "list" ? "grid" : "list"),
        },
        { label: "排序", icon: "sort", disabled: state.searchHits !== null, children: sortEntries },
        "separator",
        { label: "标签管理", icon: "tag", run: handlers.openTags },
        { label: "回收站", icon: "trash", run: handlers.openTrash },
        {
          label: "导出",
          icon: "download",
          shortcut: "Ctrl+Shift+E",
          disabled: !tab,
          run: handlers.openExport,
        },
        "separator",
        {
          label: "命令面板",
          icon: "keyboard",
          shortcut: "Ctrl+Shift+P",
          run: handlers.openPalette,
        },
        { label: "设置", icon: "settings", shortcut: "Ctrl+,", run: handlers.openSettings },
      ],
      { x: rect.right, y: rect.bottom + 5 },
    );
  }

  const tabNodes = new Map<string, TabNode>();

  function renderTab(tab: Tab): TabNode {
    const dot = el("span", { class: "tab__dot", title: "未保存" });
    const label = el("span", { class: "tab__label" });
    const close = el(
      "button",
      {
        class: "tab__close",
        type: "button",
        title: "关闭  Ctrl+W",
        onclick: (ev: MouseEvent) => {
          ev.stopPropagation();
          void actions.closeTab(tab.id);
        },
      },
      icon("close", 11),
    );
    const root = el(
      "div",
      {
        class: "tab",
        role: "tab",
        tabIndex: 0,
        onclick: () => actions.activateTab(tab.id),
        onkeydown: (ev: KeyboardEvent) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            actions.activateTab(tab.id);
          }
        },
        onauxclick: (ev: MouseEvent) => {
          if (ev.button === 1) {
            ev.preventDefault();
            void actions.closeTab(tab.id);
          }
        },
        oncontextmenu: (ev: MouseEvent) => {
          ev.preventDefault();
          showMenu(
            [
              { label: "关闭", icon: "close", run: () => void actions.closeTab(tab.id) },
              {
                label: "关闭其他",
                disabled: state.tabs.length < 2,
                run: () => void actions.closeOtherTabs(tab.id),
              },
              { label: "关闭全部", run: () => void actions.closeAllTabs() },
              "separator",
              {
                label: "在资源管理器中显示",
                icon: "folderOpen",
                run: () => {
                  const current = state.tabs.find((entry) => entry.id === tab.id);
                  if (current) void api.revealInExplorer(current.path);
                },
              },
            ],
            { x: ev.clientX, y: ev.clientY },
          );
        },
      },
      dot,
      label,
      close,
    );
    return { root, dot, label, close, title: "" };
  }

  function paintTab(tab: Tab, node: TabNode): void {
    const active = tab.id === state.activeTabId;
    node.root.classList.toggle("is-active", active);
    node.root.setAttribute("aria-selected", active ? "true" : "false");
    node.dot.hidden = !isDirty(tab) && !tab.conflict;
    node.dot.classList.toggle("is-conflict", Boolean(tab.conflict));
    node.dot.title = tab.conflict ? "存在磁盘冲突" : "未保存";

    const title = actions.tabTitle(tab);
    if (title === node.title) return;
    node.title = title;
    node.label.textContent = title;
    node.root.title = title;
    node.close.setAttribute("aria-label", `关闭 ${title}`);
  }

  function visibleTabIds(capacity: number): Set<string> {
    const tabs = state.tabs;
    if (tabs.length <= capacity) return new Set(tabs.map((tab) => tab.id));
    const active = Math.max(0, tabs.findIndex((tab) => tab.id === state.activeTabId));
    const start = Math.max(
      0,
      Math.min(active - Math.floor((capacity - 1) / 2), tabs.length - capacity),
    );
    return new Set(tabs.slice(start, start + capacity).map((tab) => tab.id));
  }

  function layoutTabs(): void {
    const width = tabArea.clientWidth;
    const needsOverflow = state.tabs.length * TAB_BUDGET > width;
    const capacity = Math.max(
      1,
      Math.floor((width - (needsOverflow ? OVERFLOW_BUDGET : 0)) / TAB_BUDGET),
    );
    const visible = visibleTabIds(capacity);
    hiddenTabIds.clear();
    for (const tab of state.tabs) {
      const hidden = !visible.has(tab.id);
      tabNodes.get(tab.id)?.root.toggleAttribute("hidden", hidden);
      if (hidden) hiddenTabIds.add(tab.id);
    }
    overflowButton.hidden = hiddenTabIds.size === 0;
    const count = overflowButton.querySelector<HTMLElement>(".workspacebar__overflow-count");
    if (count) count.textContent = hiddenTabIds.size ? String(hiddenTabIds.size) : "";
  }

  function syncTabs(): void {
    for (const [id, node] of tabNodes) {
      if (state.tabs.some((tab) => tab.id === id)) continue;
      node.root.remove();
      tabNodes.delete(id);
    }

    let previous: Element | null = null;
    for (const tab of state.tabs) {
      let node = tabNodes.get(tab.id);
      if (!node) {
        node = renderTab(tab);
        tabNodes.set(tab.id, node);
      }
      const slot: Element | null = previous
        ? previous.nextElementSibling
        : strip.firstElementChild;
      if (slot !== node.root) strip.insertBefore(node.root, slot);
      previous = node.root;
      paintTab(tab, node);
    }

    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    const previewing = active?.mode === "preview";
    modeButton.replaceChildren(icon(previewing ? "pencil" : "eye", 15));
    modeButton.title = previewing ? "返回编辑  Ctrl+P" : "预览  Ctrl+P";
    modeButton.setAttribute("aria-label", modeButton.title);
    modeButton.classList.toggle("is-active", Boolean(previewing));
    modeButton.toggleAttribute("disabled", !active);
    propertiesButton.classList.toggle("is-active", state.propertiesVisible);
    propertiesButton.setAttribute("aria-pressed", state.propertiesVisible ? "true" : "false");
    requestAnimationFrame(layoutTabs);
  }

  function paintActiveTab(): void {
    const tab = state.tabs.find((entry) => entry.id === state.activeTabId);
    if (!tab) return;
    const node = tabNodes.get(tab.id);
    if (node) paintTab(tab, node);
  }

  overflowButton.addEventListener("click", () => {
    const rect = anchorRect(overflowButton);
    const hidden = state.tabs.filter((tab) => hiddenTabIds.has(tab.id));
    showMenu(
      hidden.map((tab) => ({
        label: actions.tabTitle(tab),
        icon: tab.conflict ? "alert" : isDirty(tab) ? "edit" : "note",
        run: () => actions.activateTab(tab.id),
      })),
      { x: rect.left, y: rect.bottom + 5 },
    );
  });

  const removeDoubleClick = on(bar, "dblclick", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest("button, .tab")) return;
    void api.windowToggleMaximise();
  });
  const observer = new ResizeObserver(layoutTabs);
  observer.observe(tabArea);

  const unsubscribeTabs = subscribe(["tabs", "activeTabId", "propertiesVisible"], syncTabs);
  const unsubscribeDoc = subscribe(["docRevision"], paintActiveTab);
  syncTabs();

  return disposableElement(bar, () => {
    unsubscribeTabs();
    unsubscribeDoc();
    observer.disconnect();
    removeDoubleClick();
    tabNodes.clear();
    controls.destroy();
  });
}
