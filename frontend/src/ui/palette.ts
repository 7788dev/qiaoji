import * as actions from "../actions";
import * as api from "../api";
import { el, icon, kbd } from "../lib/dom";
import { relativeTime } from "../lib/format";
import { activeTab, state, subscribe } from "../store";
import type { NoteMeta } from "../types";
import { openModal, type ModalHandle } from "./modal";

export interface Command {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  group: string;
  /** Hidden when this returns false, so the list never offers dead actions. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

export interface PaletteDeps {
  toggleMode: () => void;
  openExport: () => void;
  openSettings: () => void;
  openShortcuts: () => void;
  openAbout: () => void;
  openTrash: () => void;
  openTags: () => void;
  openSearch: () => void;
  openFind: () => void;
  openReplace: () => void;
  setTheme: (theme: "light" | "dark" | "system") => void;
  toggleSidebar: () => void;
}

export function buildCommands(deps: PaletteDeps): Command[] {
  const hasTab = () => activeTab() !== null;

  return [
    {
      id: "new-note",
      label: "新建笔记",
      icon: "plus",
      shortcut: "Ctrl+N",
      group: "文件",
      run: () => actions.newNote(),
    },
    {
      id: "save",
      label: "保存",
      icon: "save",
      shortcut: "Ctrl+S",
      group: "文件",
      when: hasTab,
      run: () => actions.saveActive(),
    },
    {
      id: "export",
      label: "导出",
      icon: "download",
      shortcut: "Ctrl+E",
      group: "文件",
      when: hasTab,
      run: deps.openExport,
    },
    {
      id: "reveal",
      label: "在资源管理器中显示",
      icon: "folderOpen",
      group: "文件",
      when: hasTab,
      run: () => {
        const tab = activeTab();
        if (tab) void api.revealInExplorer(tab.path);
      },
    },
    {
      id: "close-tab",
      label: "关闭当前标签",
      icon: "close",
      shortcut: "Ctrl+W",
      group: "文件",
      when: hasTab,
      run: () => {
        const tab = activeTab();
        if (tab) void actions.closeTab(tab.id);
      },
    },

    {
      id: "find",
      label: "查找",
      icon: "search",
      shortcut: "Ctrl+F",
      group: "编辑",
      when: hasTab,
      run: deps.openFind,
    },
    {
      id: "replace",
      label: "替换",
      icon: "edit",
      shortcut: "Ctrl+H",
      group: "编辑",
      when: hasTab,
      run: deps.openReplace,
    },
    {
      id: "search-all",
      label: "全文搜索",
      icon: "search",
      shortcut: "Ctrl+Shift+F",
      group: "编辑",
      run: deps.openSearch,
    },
    {
      id: "favorite",
      label: "收藏 / 取消收藏",
      icon: "star",
      group: "编辑",
      when: hasTab,
      run: () => {
        const tab = activeTab();
        if (tab) void actions.toggleFavorite(tab.path);
      },
    },
    {
      id: "delete",
      label: "移入回收站",
      icon: "trash",
      group: "编辑",
      when: hasTab,
      run: () => {
        const tab = activeTab();
        if (tab) void actions.deleteNote(tab.path);
      },
    },

    {
      id: "toggle-preview",
      label: "预览 / 编辑切换",
      icon: "eye",
      shortcut: "Ctrl+P",
      group: "视图",
      when: hasTab,
      run: deps.toggleMode,
    },
    {
      id: "toggle-sidebar",
      label: "显示 / 隐藏侧边栏",
      icon: "sidebar",
      shortcut: "Ctrl+\\",
      group: "视图",
      run: deps.toggleSidebar,
    },
    {
      id: "view-list",
      label: "列表视图",
      icon: "list",
      group: "视图",
      run: () => actions.setListView("list"),
    },
    {
      id: "view-grid",
      label: "网格视图",
      icon: "grid",
      group: "视图",
      run: () => actions.setListView("grid"),
    },
    {
      id: "theme-light",
      label: "主题：浅色",
      icon: "sun",
      group: "视图",
      run: () => deps.setTheme("light"),
    },
    {
      id: "theme-dark",
      label: "主题：深色",
      icon: "moon",
      group: "视图",
      run: () => deps.setTheme("dark"),
    },
    {
      id: "theme-system",
      label: "主题：跟随系统",
      icon: "layout",
      group: "视图",
      run: () => deps.setTheme("system"),
    },

    { id: "tags", label: "标签管理", icon: "tag", group: "管理", run: deps.openTags },
    { id: "trash", label: "回收站", icon: "trash", group: "管理", run: deps.openTrash },
    {
      id: "rebuild",
      label: "重建搜索索引",
      icon: "refresh",
      group: "管理",
      run: async () => {
        const stats = await api.rebuildIndex();
        await actions.refreshAll();
        return void stats;
      },
    },

    {
      id: "settings",
      label: "设置",
      icon: "settings",
      shortcut: "Ctrl+,",
      group: "其他",
      run: deps.openSettings,
    },
    {
      id: "shortcuts",
      label: "快捷键",
      icon: "keyboard",
      shortcut: "Ctrl+/",
      group: "其他",
      run: deps.openShortcuts,
    },
    {
      id: "about",
      label: "关于巧记",
      icon: "info",
      group: "其他",
      run: deps.openAbout,
    },
  ];
}

/* ---------------------------------------------------------------- palette */

type Entry =
  | { kind: "command"; command: Command }
  | { kind: "note"; note: NoteMeta };

/**
 * Command palette. Typing plain text filters commands; a leading `>` forces
 * command mode and anything else also searches note titles, so one shortcut
 * covers "run something" and "go somewhere".
 */
export function openPalette(commands: Command[]): ModalHandle {
  const input = el("input", {
    type: "text",
    placeholder: "搜索命令或笔记…",
    spellcheck: false,
    "aria-label": "搜索命令或笔记",
  });

  const list = el("div", { class: "palette__list scroll", role: "listbox" });
  let entries: Entry[] = [];
  let active = 0;
  let requestId = 0;

  function score(haystack: string, needle: string): number {
    if (!needle) return 1;
    const target = haystack.toLowerCase();
    const query = needle.toLowerCase();
    const index = target.indexOf(query);
    if (index === 0) return 3;
    if (index > 0) return 2;
    // Subsequence match, so "xjbj" can still find "新建笔记" typed loosely.
    let cursor = 0;
    for (const ch of query) {
      cursor = target.indexOf(ch, cursor);
      if (cursor < 0) return 0;
      cursor++;
    }
    return 1;
  }

  function availableCommands(query: string): Command[] {
    return commands
      .filter((c) => c.when?.() !== false)
      .map((c) => ({ c, s: score(c.label, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }

  async function refresh(): Promise<void> {
    const raw = input.value.trim();
    const commandMode = raw.startsWith(">");
    const query = commandMode ? raw.slice(1).trim() : raw;
    const id = ++requestId;

    const matched = availableCommands(query);
    let notes: NoteMeta[] = [];
    if (!commandMode) {
      try {
        notes = await api.suggest(query, query ? 8 : 6);
      } catch {
        notes = [];
      }
      if (id !== requestId) return;
    }

    entries = [
      ...matched.map((command) => ({ kind: "command", command }) as Entry),
      ...notes.map((note) => ({ kind: "note", note }) as Entry),
    ];
    active = 0;
    paint();
  }

  function paint(): void {
    list.replaceChildren();
    if (entries.length === 0) {
      list.appendChild(
        el(
          "div",
          { class: "palette__group", style: { padding: "var(--sp-6)", textAlign: "center" } },
          "没有匹配的结果",
        ),
      );
      return;
    }

    let lastGroup = "";
    entries.forEach((entry, index) => {
      const group = entry.kind === "command" ? entry.command.group : "笔记";
      if (group !== lastGroup) {
        lastGroup = group;
        list.appendChild(el("div", { class: "palette__group" }, group));
      }

      const isActive = index === active;
      const node =
        entry.kind === "command"
          ? el(
              "button",
              {
                class: `palette__item${isActive ? " is-active" : ""}`,
                type: "button",
                role: "option",
                "aria-selected": isActive ? "true" : "false",
                onclick: () => choose(index),
                onmousemove: () => setActive(index),
              },
              el("span", { class: "icon" }, icon(entry.command.icon ?? "chevronRight", 15)),
              el("span", { class: "palette__label" }, entry.command.label),
              entry.command.shortcut ? kbd(entry.command.shortcut) : null,
            )
          : el(
              "button",
              {
                class: `palette__item${isActive ? " is-active" : ""}`,
                type: "button",
                role: "option",
                "aria-selected": isActive ? "true" : "false",
                onclick: () => choose(index),
                onmousemove: () => setActive(index),
              },
              el("span", { class: "icon" }, icon("note", 15)),
              el("span", { class: "palette__label" }, entry.note.title || "未命名笔记"),
              el("span", { class: "palette__sub" }, relativeTime(entry.note.updated)),
            );
      list.appendChild(node);
    });

    list.querySelector<HTMLElement>(".palette__item.is-active")?.scrollIntoView({
      block: "nearest",
    });
  }

  function setActive(index: number): void {
    if (index === active) return;
    active = index;
    paint();
  }

  function move(delta: number): void {
    if (entries.length === 0) return;
    active = (active + delta + entries.length) % entries.length;
    paint();
  }

  function choose(index: number): void {
    const entry = entries[index];
    if (!entry) return;
    handle.close();
    if (entry.kind === "command") void entry.command.run();
    else void actions.openNote(entry.note);
  }

  input.addEventListener("input", () => void refresh());
  input.addEventListener("keydown", (ev) => {
    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        move(-1);
        break;
      case "Home":
        ev.preventDefault();
        setActive(0);
        break;
      case "End":
        ev.preventDefault();
        setActive(entries.length - 1);
        break;
      case "Enter":
        ev.preventDefault();
        choose(active);
        break;
      default:
        break;
    }
  });

  const handle = openModal({
    variant: "palette",
    align: "top",
    showCloseButton: false,
    body: [
      el(
        "div",
        { class: "palette__search" },
        el("span", { class: "search-field__icon" }, icon("search", 16)),
        input,
      ),
      list,
      el(
        "div",
        { class: "palette__foot" },
        el("span", null, kbd("↑"), kbd("↓"), " 选择"),
        el("span", null, kbd("Enter"), " 执行"),
        el("span", null, kbd("Esc"), " 关闭"),
        el("div", { class: "spacer" }),
        el("span", null, "输入 > 只看命令"),
      ),
    ],
    initialFocus: () => input,
  });

  void refresh();
  return handle;
}

/* ---------------------------------------------------------------- search */

/** Full-text search overlay, driving the note list rather than its own list. */
export function openSearchPanel(): ModalHandle {
  const input = el("input", {
    type: "text",
    placeholder: "搜索全部笔记…",
    spellcheck: false,
    value: state.searchQuery,
    "aria-label": "搜索全部笔记",
  });

  const results = el("div", { class: "palette__list scroll", role: "listbox" });
  let active = 0;

  function paint(): void {
    const hits = state.searchHits ?? [];
    results.replaceChildren();

    if (state.searching) {
      results.appendChild(
        el(
          "div",
          { class: "palette__group", style: { padding: "var(--sp-6)", textAlign: "center" } },
          "搜索中…",
        ),
      );
      return;
    }
    if (!state.searchQuery.trim()) {
      results.appendChild(
        el(
          "div",
          { class: "palette__group", style: { padding: "var(--sp-6)", textAlign: "center" } },
          "输入关键词开始搜索，支持中文两字词",
        ),
      );
      return;
    }
    if (hits.length === 0) {
      results.appendChild(
        el(
          "div",
          { class: "palette__group", style: { padding: "var(--sp-6)", textAlign: "center" } },
          "没有找到匹配的笔记",
        ),
      );
      return;
    }

    hits.forEach((hit, index) => {
      const title = el("span", { class: "palette__label" });
      title.innerHTML = hit.titleHtml || hit.title;
      const snippet = el("div", { class: "note-row__excerpt" });
      snippet.innerHTML = hit.snippet;

      results.appendChild(
        el(
          "button",
          {
            class: `palette__item${index === active ? " is-active" : ""}`,
            type: "button",
            role: "option",
            style: { display: "block", padding: "var(--sp-3) var(--sp-4)", height: "auto" },
            onclick: () => {
              handle.close();
              void actions.openNote(hit.path);
            },
            onmousemove: () => {
              if (active === index) return;
              active = index;
              paint();
            },
          },
          el(
            "div",
            { style: { display: "flex", alignItems: "baseline", gap: "var(--sp-3)" } },
            title,
            el("span", { class: "palette__sub" }, relativeTime(hit.updated)),
          ),
          snippet,
        ),
      );
    });

    results.querySelector<HTMLElement>(".palette__item.is-active")?.scrollIntoView({
      block: "nearest",
    });
  }

  input.addEventListener("input", () => {
    active = 0;
    actions.setSearchQuery(input.value);
  });
  input.addEventListener("keydown", (ev) => {
    const hits = state.searchHits ?? [];
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      active = Math.min(active + 1, hits.length - 1);
      paint();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      active = Math.max(active - 1, 0);
      paint();
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const hit = hits[active];
      if (hit) {
        handle.close();
        void actions.openNote(hit.path);
      }
    }
  });

  const unsubscribe = subscribe(["searchHits", "searching", "searchQuery"], paint);

  const handle = openModal({
    variant: "palette",
    align: "top",
    showCloseButton: false,
    body: [
      el(
        "div",
        { class: "palette__search" },
        el("span", { class: "search-field__icon" }, icon("search", 16)),
        input,
      ),
      results,
      el(
        "div",
        { class: "palette__foot" },
        el("span", null, kbd("Enter"), " 打开"),
        el("span", null, kbd("Esc"), " 关闭"),
        el("div", { class: "spacer" }),
        el("span", null, "两个字的中文词也能搜到"),
      ),
    ],
    initialFocus: () => {
      input.select();
      return input;
    },
    onClose: () => {
      unsubscribe();
      actions.clearSearch();
    },
  });

  paint();
  if (state.searchQuery) actions.setSearchQuery(state.searchQuery);
  return handle;
}
