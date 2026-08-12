import * as actions from "../actions";
import * as api from "../api";
import markUrl from "../assets/mark.png";
import { el, icon, on } from "../lib/dom";
import { isDirty, state, subscribe } from "../store";
import type { Tab } from "../types";
import { showMenu } from "./menu";

export interface TitlebarHandlers {
  openPalette: () => void;
  openSearch: () => void;
  openSettings: () => void;
  toggleSidebar: () => void;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The application mark. Vite fingerprints and inlines the import, so this is
 * one asset shared by the title bar, the About dialog and the fallback screen
 * rather than three hand-tuned copies.
 */
export function brandMark(className: string): HTMLElement {
  return el("img", {
    class: className,
    src: markUrl,
    alt: "巧记",
    draggable: false,
  });
}

/** Window control glyphs, drawn to match the Windows 11 title bar metrics. */
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

/**
 * Minimise / maximise / close. Extracted so the welcome screen has them too;
 * a frameless window with no way to close it is a trap.
 */
export function createWindowControls(): HTMLElement {
  const maxButton = el("button", {
    class: "wbtn",
    type: "button",
    title: "最大化",
    "aria-label": "最大化",
    onclick: () => {
      void api.windowToggleMaximise().then(paintMaxButton);
    },
  });

  async function paintMaxButton(): Promise<void> {
    const maximised = await api.windowIsMaximised();
    maxButton.replaceChildren(windowGlyph(maximised ? "restore" : "max"));
    maxButton.title = maximised ? "向下还原" : "最大化";
  }
  void paintMaxButton();
  on(window, "resize", () => void paintMaxButton());

  return el(
    "div",
    { class: "titlebar__controls" },
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
}

export function createTitlebar(handlers: TitlebarHandlers): HTMLElement {
  const bar = el(
    "header",
    { class: "titlebar" },
    brandMark("titlebar__mark"),
    el("span", { class: "titlebar__title" }, "巧记"),
    el("div", { class: "spacer" }),
    el(
      "div",
      { class: "titlebar__actions" },
      iconButton("sidebar", "显示/隐藏侧边栏  Ctrl+\\", handlers.toggleSidebar),
      iconButton("search", "搜索  Ctrl+F", handlers.openSearch),
      iconButton("more", "命令面板  Ctrl+Shift+P", handlers.openPalette),
      iconButton("settings", "设置", handlers.openSettings),
    ),
    createWindowControls(),
  );

  // Double-clicking the drag region is the standard maximise gesture, and its
  // absence in a frameless window is immediately noticeable.
  on(bar, "dblclick", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest(".titlebar__actions, .titlebar__controls")) return;
    void api.windowToggleMaximise();
  });

  return bar;
}

function iconButton(name: string, title: string, run: () => void): HTMLElement {
  return el(
    "button",
    { class: "ibtn", type: "button", title, "aria-label": title, onclick: run },
    icon(name, 15),
  );
}

/* ---------------------------------------------------------------- tab strip */

export interface TabbarHandlers {
  newNote: () => void;
  toggleList: () => void;
  toggleMode: () => void;
  openExport: () => void;
  openOutline: (anchor: HTMLElement) => void;
}

export function createTabbar(handlers: TabbarHandlers): HTMLElement {
  const strip = el("div", { class: "tabbar__strip", role: "tablist" });

  const modeButton = el("button", {
    class: "ibtn",
    type: "button",
    title: "预览  Ctrl+P",
    "aria-label": "切换预览",
    onclick: handlers.toggleMode,
  });

  const outlineButton = el("button", { class: "ibtn", type: "button", title: "大纲" });
  outlineButton.appendChild(icon("list", 15));
  outlineButton.addEventListener("click", () => handlers.openOutline(outlineButton));

  const bar = el(
    "nav",
    { class: "tabbar" },
    strip,
    el(
      "button",
      {
        class: "tabbar__new",
        type: "button",
        title: "新建笔记  Ctrl+N",
        "aria-label": "新建笔记",
        onclick: handlers.newNote,
      },
      icon("plus", 15),
    ),
    el("div", { class: "spacer" }),
    el(
      "div",
      { class: "tabbar__right" },
      el(
        "button",
        {
          class: "ibtn",
          type: "button",
          title: "显示/隐藏笔记列表",
          "aria-label": "显示或隐藏笔记列表",
          onclick: handlers.toggleList,
        },
        icon("columns", 15),
      ),
      outlineButton,
      modeButton,
      el(
        "button",
        {
          class: "ibtn",
          type: "button",
          title: "导出  Ctrl+E",
          "aria-label": "导出",
          onclick: handlers.openExport,
        },
        icon("download", 15),
      ),
    ),
  );

  function renderTab(tab: Tab): HTMLElement {
    const active = tab.id === state.activeTabId;
    const dirty = isDirty(tab);
    const title = actions.tabTitle(tab);

    const node = el(
      "div",
      {
        class: `tab${active ? " is-active" : ""}`,
        role: "tab",
        "aria-selected": active ? "true" : "false",
        title,
        tabIndex: 0,
        onclick: () => actions.activateTab(tab.id),
        onkeydown: (ev: KeyboardEvent) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            actions.activateTab(tab.id);
          }
        },
        onauxclick: (ev: MouseEvent) => {
          // Middle-click closes, matching every tabbed interface.
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
                run: () => void api.revealInExplorer(tab.path),
              },
            ],
            { x: ev.clientX, y: ev.clientY },
          );
        },
      },
      dirty ? el("span", { class: "tab__dot", title: "未保存" }) : null,
      el("span", { class: "tab__label" }, title),
      el(
        "button",
        {
          class: "tab__close",
          type: "button",
          title: "关闭  Ctrl+W",
          "aria-label": `关闭 ${title}`,
          onclick: (ev: MouseEvent) => {
            ev.stopPropagation();
            void actions.closeTab(tab.id);
          },
        },
        icon("close", 11),
      ),
    );
    return node;
  }

  function paint(): void {
    strip.replaceChildren(...state.tabs.map(renderTab));
    const active = strip.querySelector<HTMLElement>(".tab.is-active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });

    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    const previewing = tab?.mode === "preview";
    modeButton.replaceChildren(icon(previewing ? "pencil" : "eye", 15));
    modeButton.title = previewing ? "编辑  Ctrl+P" : "预览  Ctrl+P";
    modeButton.classList.toggle("is-active", previewing);
    modeButton.disabled = !tab;
    outlineButton.disabled = !tab;
  }

  subscribe(["tabs", "activeTabId"], paint);
  paint();

  return bar;
}
