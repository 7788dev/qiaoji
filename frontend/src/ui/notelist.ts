import * as actions from "../actions";
import * as api from "../api";
import {
  disposableElement,
  el,
  icon,
  type DisposableHTMLElement,
} from "../lib/dom";
import { fullTime, relativeTime } from "../lib/format";
import { VirtualList } from "../lib/virtual";
import { currentScopeLabel, state, subscribe } from "../store";
import type { NoteMeta, SearchHit, SortBy, TrashItem } from "../types";
import { anchorRect, showMenu } from "./menu";
import { confirm, prompt } from "./modal";

// Rows are a fixed height so the list can be virtualised. The values below are
// the exact rendered heights of the row and card templates; anything taller
// would spill into the neighbouring item.
/** Drag payload identifying a note, read by the sidebar's folder drop targets. */
export const DRAG_TYPE = "text/qiaoji-note-path";

const ROW_HEIGHT = 80;
const CARD_HEIGHT = 132;
const CARD_GAP = 10;
// Grid view spans the whole content area, so cards can be wide enough to show
// a couple of readable lines rather than a sliver of text.
const CARD_MIN_WIDTH = 224;

const SORT_LABELS: Record<SortBy, string> = {
  updated: "修改时间",
  created: "创建时间",
  title: "标题",
};

/** A search hit and a note share just enough shape for one row renderer. */
interface Row {
  id: string;
  path: string;
  title: string;
  titleHtml?: string;
  excerpt: string;
  excerptHtml?: string;
  updated: string;
  folder: string;
  favorite: boolean;
}

function rowFromMeta(note: NoteMeta): Row {
  return {
    id: note.id || note.path,
    path: note.path,
    title: note.title,
    excerpt: note.excerpt,
    updated: note.updated,
    folder: note.folder,
    favorite: note.favorite,
  };
}

function rowFromHit(hit: SearchHit): Row {
  return {
    id: hit.id || hit.path,
    path: hit.path,
    title: hit.title,
    titleHtml: hit.titleHtml,
    excerpt: "",
    excerptHtml: hit.snippet,
    updated: hit.updated,
    folder: hit.folder,
    favorite: hit.favorite,
  };
}

export function createNoteList(): DisposableHTMLElement {
  const title = el("span", { class: "notelist__title" });
  const count = el("span", { class: "notelist__count" });

  const sortButton = el("button", {
    class: "ibtn ibtn--sm",
    type: "button",
    title: "排序方式",
    "aria-label": "排序方式",
  });
  sortButton.appendChild(icon("sort", 14));
  sortButton.addEventListener("click", () => {
    const rect = anchorRect(sortButton);
    showMenu(
      (Object.keys(SORT_LABELS) as SortBy[]).map((key) => ({
        label: SORT_LABELS[key],
        icon: state.sortBy === key ? "check" : undefined,
        run: () => actions.setSortBy(key),
      })),
      { x: rect.left, y: rect.bottom + 4 },
    );
  });

  const viewButton = el("button", {
    class: "ibtn ibtn--sm",
    type: "button",
    title: "切换视图",
    "aria-label": "切换列表或网格视图",
    onclick: () => actions.setListView(state.listView === "list" ? "grid" : "list"),
  });

  // The rows carry role="option", which is only meaningful inside a listbox.
  const scroller = el("div", {
    class: "notelist__scroll scroll",
    role: "listbox",
    "aria-label": "笔记",
  });

  const root = el(
    "section",
    { class: "notelist", "aria-label": "笔记列表" },
    el(
      "div",
      { class: "notelist__head" },
      title,
      count,
      el("div", { class: "spacer" }),
      sortButton,
      viewButton,
    ),
    scroller,
  );

  /* ------------------------------------------------------------ rows */

  function openContextMenu(row: Row, x: number, y: number): void {
    void (async () => {
      const folders = await api.sortedFolderNames().catch(() => [] as string[]);
      showMenu(
        [
          { label: "打开", icon: "note", run: () => void actions.openNote(row.path) },
          {
            label: row.favorite ? "取消收藏" : "加入收藏",
            icon: "star",
            run: () => void actions.toggleFavorite(row.path),
          },
          {
            label: "重命名",
            icon: "pencil",
            run: async () => {
              const next = await prompt({
                title: "重命名笔记",
                label: "标题",
                value: row.title,
              });
              if (next && next !== row.title) await actions.renameNote(row.path, next);
            },
          },
          { label: "创建副本", icon: "copy", run: () => void actions.duplicateNote(row.path) },
          "separator",
          ...(folders.length > 1
            ? [
                {
                  label: "移动到…",
                  icon: "folder",
                  run: () => {
                    showMenu(
                      folders
                        .filter((f) => f !== row.folder)
                        .map((folder) => ({
                          label: folder || "根目录",
                          icon: "folder",
                          run: () => void actions.moveNote(row.path, folder),
                        })),
                      { x, y },
                    );
                  },
                } as const,
              ]
            : []),
          {
            label: "在资源管理器中显示",
            icon: "folderOpen",
            run: () => void api.revealInExplorer(row.path),
          },
          "separator",
          {
            label: "移入回收站",
            icon: "trash",
            danger: true,
            run: () => void actions.deleteNote(row.path),
          },
        ],
        { x, y },
      );
    })();
  }

  /**
   * Moves focus between rows. The virtual list only keeps the visible window
   * in the DOM, so the target is scrolled into view first and focused on the
   * next frame once it exists.
   */
  function focusRow(index: number): void {
    const total = currentRows().length;
    if (total === 0) return;
    const clamped = Math.min(Math.max(0, index), total - 1);
    list.scrollToIndex(clamped);
    requestAnimationFrame(() => {
      scroller
        .querySelector<HTMLElement>(`[data-index="${clamped}"]`)
        ?.focus();
    });
  }

  /**
   * Opens a note from the list. Grid view hides the editor, so picking a card
   * also drops back to list view — otherwise the note would open somewhere the
   * user cannot see.
   */
  async function openFromList(path: string): Promise<void> {
    const wasGrid = state.listView === "grid";
    if (wasGrid) actions.setListView("list");
    await actions.openNote(path);
  }

  function bindRow(node: HTMLElement, row: Row, index: number): void {
    node.dataset.path = row.path;
    node.dataset.index = String(index);
    node.tabIndex = 0;
    node.draggable = true;

    node.addEventListener("click", () => void openFromList(row.path));
    node.addEventListener("keydown", (ev) => {
      switch (ev.key) {
        case "Enter":
        case " ":
          ev.preventDefault();
          void openFromList(row.path);
          break;
        case "ArrowDown":
          ev.preventDefault();
          focusRow(index + (state.listView === "grid" ? gridColumns : 1));
          break;
        case "ArrowUp":
          ev.preventDefault();
          focusRow(index - (state.listView === "grid" ? gridColumns : 1));
          break;
        case "ArrowRight":
          if (state.listView !== "grid") return;
          ev.preventDefault();
          focusRow(index + 1);
          break;
        case "ArrowLeft":
          if (state.listView !== "grid") return;
          ev.preventDefault();
          focusRow(index - 1);
          break;
        case "Home":
          ev.preventDefault();
          focusRow(0);
          break;
        case "End":
          ev.preventDefault();
          focusRow(currentRows().length - 1);
          break;
        case "Delete":
          ev.preventDefault();
          void actions.deleteNote(row.path);
          break;
        default:
          break;
      }
    });
    node.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      openContextMenu(row, ev.clientX, ev.clientY);
    });
    node.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData(DRAG_TYPE, row.path);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      node.classList.add("is-dragging");
    });
    node.addEventListener("dragend", () => node.classList.remove("is-dragging"));
  }

  /**
   * The folder only earns a slot when the current view mixes folders. Inside a
   * folder it would repeat the same word on every row.
   */
  function showsFolder(): boolean {
    return state.scope !== "folder" && state.listView === "list";
  }

  function currentRows(): Row[] {
    return state.searchHits !== null
      ? state.searchHits.map(rowFromHit)
      : state.notes.map(rowFromMeta);
  }

  function renderRow(row: Row, index: number): HTMLElement {
    const active = state.tabs.some((t) => t.path === row.path && t.id === state.activeTabId);

    const titleNode = el("div", { class: "note-row__title" });
    if (row.titleHtml) titleNode.innerHTML = row.titleHtml;
    else titleNode.textContent = row.title || "未命名笔记";

    const excerptNode = el("div", { class: "note-row__excerpt" });
    if (row.excerptHtml) excerptNode.innerHTML = row.excerptHtml;
    else excerptNode.textContent = row.excerpt || "空白笔记";

    const tooltip = [row.title, row.folder && `位于 ${row.folder}`, fullTime(row.updated)]
      .filter(Boolean)
      .join("\n");

    const node = el(
      "div",
      {
        class: `note-row${active ? " is-active" : ""}`,
        role: "option",
        "aria-selected": active ? "true" : "false",
        title: tooltip,
      },
      el(
        "div",
        { class: "note-row__top" },
        row.favorite
          ? el("span", { class: "note-row__star", title: "已收藏" }, icon("star", 11))
          : null,
        titleNode,
        row.folder && showsFolder()
          ? el("span", { class: "note-row__folder" }, row.folder)
          : null,
        el("span", { class: "note-row__time" }, relativeTime(row.updated)),
      ),
      excerptNode,
    );
    bindRow(node, row, index);
    return node;
  }

  function renderCard(row: Row, index: number): HTMLElement {
    const active = state.tabs.some((t) => t.path === row.path && t.id === state.activeTabId);

    const titleNode = el("div", { class: "note-card__title" });
    if (row.titleHtml) titleNode.innerHTML = row.titleHtml;
    else titleNode.textContent = row.title || "未命名笔记";

    const excerptNode = el("div", { class: "note-card__excerpt" });
    if (row.excerptHtml) excerptNode.innerHTML = row.excerptHtml;
    else excerptNode.textContent = row.excerpt || "空白笔记";

    const node = el(
      "div",
      {
        class: `note-card${active ? " is-active" : ""}`,
        role: "option",
        "aria-selected": active ? "true" : "false",
        title: `${row.title}\n${fullTime(row.updated)}`,
      },
      titleNode,
      excerptNode,
      el(
        "div",
        { class: "note-card__foot" },
        row.favorite ? el("span", { class: "note-row__star" }, icon("star", 11)) : null,
        el("span", null, relativeTime(row.updated)),
      ),
    );
    bindRow(node, row, index);
    return node;
  }

  let gridColumns = 1;

  const list = new VirtualList<Row>({
    scroller,
    rowHeight: ROW_HEIGHT,
    key: (row) => row.id,
    render: (row, index) =>
      state.listView === "grid" ? renderCard(row, index) : renderRow(row, index),
  });

  /* ------------------------------------------------------------ empty states */

  function emptyState(): HTMLElement | null {
    // A first load or a scope switch on a slow drive used to show nothing at
    // all: no rows, no message, just an empty column.
    if (state.loadingList && state.notes.length === 0 && state.searchHits === null) {
      return el(
        "div",
        { class: "empty" },
        el("div", { class: "empty__icon" }, el("span", { class: "spinner" })),
        el("div", { class: "empty__title" }, "正在读取笔记…"),
      );
    }
    if (state.loadingList) return null;
    if (state.searchHits !== null) {
      if (state.searchHits.length > 0) return null;
      return el(
        "div",
        { class: "empty" },
        el("div", { class: "empty__icon" }, icon("search", 22)),
        el("div", { class: "empty__title" }, "没有找到匹配的笔记"),
        el("div", { class: "empty__hint" }, `换个关键词试试，或者检查一下有没有错别字。`),
      );
    }
    if (state.notes.length > 0) return null;

    const scopedHint =
      state.scope === "favorites"
        ? "把常看的笔记加入收藏，就会出现在这里。"
        : state.scope === "folder"
          ? "这个文件夹还是空的。"
          : "开始记录第一条想法吧。";

    return el(
      "div",
      { class: "empty" },
      el("div", { class: "empty__icon" }, icon("notes", 22)),
      el("div", { class: "empty__title" }, "还没有笔记"),
      el("div", { class: "empty__hint" }, scopedHint),
      el(
        "button",
        { class: "btn btn--primary", type: "button", onclick: () => void actions.newNote() },
        icon("plus", 14),
        "新建笔记",
      ),
    );
  }

  /* ------------------------------------------------------------ painting */

  let emptyNode: HTMLElement | null = null;

  function columnsForWidth(): number {
    if (state.listView !== "grid") return 1;
    const width = scroller.clientWidth - 16;
    return Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  }

  function paintHeader(): void {
    title.textContent = state.searchHits !== null ? "搜索结果" : currentScopeLabel();
    const total = state.searchHits !== null ? state.searchHits.length : state.notes.length;
    count.textContent = total > 0 ? String(total) : "";
    viewButton.replaceChildren(icon(state.listView === "grid" ? "list" : "grid", 14));
    viewButton.title = state.listView === "grid" ? "切换为列表视图" : "切换为网格视图";
    sortButton.disabled = state.searchHits !== null;
  }

  function paintRows(preserveScroll: boolean): void {
    root.classList.toggle("is-grid", state.listView === "grid");

    const rows = currentRows();

    emptyNode?.remove();
    emptyNode = emptyState();
    if (emptyNode) {
      scroller.replaceChildren(emptyNode);
      return;
    }

    if (state.listView === "grid") {
      gridColumns = columnsForWidth();
      list.setColumns(gridColumns);
      list.setRowHeight(CARD_HEIGHT, CARD_GAP);
    } else {
      gridColumns = 1;
      list.setColumns(1);
      list.setRowHeight(ROW_HEIGHT, 0);
    }
    list.setItems(rows, { preserveScroll });
    paintActiveRow();
  }

  /**
   * Marks the row of the note that is open.
   *
   * This used to rebuild every visible row, which meant a dozen row subtrees
   * and their listeners were thrown away and recreated whenever a tab changed
   * — including once per keystroke. Toggling two classes does the same job and
   * keeps focus and in-progress drags on the rows that already exist.
   */
  function paintActiveRow(): void {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    const path = tab?.path ?? "";
    scroller.querySelectorAll<HTMLElement>("[data-path]").forEach((node) => {
      const active = node.dataset.path === path;
      node.classList.toggle("is-active", active);
      node.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  const unsubscribeRows = subscribe(["notes", "searchHits", "listView", "loadingList"], () => {
    paintHeader();
    paintRows(false);
  });
  const unsubscribeHeader = subscribe(["scope", "scopeValue", "sortBy"], paintHeader);
  const unsubscribeActive = subscribe(["activeTabId", "tabs"], paintActiveRow);

  // The card count depends on the width of the list column, which changes when
  // a panel is toggled as well as when the window is resized. Watching the
  // element covers both; watching the window left the grid at a stale column
  // count until the window itself moved.
  const columnObserver = new ResizeObserver(() => {
    if (state.listView !== "grid") return;
    const columns = columnsForWidth();
    if (columns === gridColumns) return;
    gridColumns = columns;
    list.setColumns(columns);
  });
  columnObserver.observe(scroller);

  paintHeader();
  paintRows(false);

  return disposableElement(root, () => {
    unsubscribeRows();
    unsubscribeHeader();
    unsubscribeActive();
    columnObserver.disconnect();
    list.destroy();
  });
}

/* ---------------------------------------------------------------- trash view */

/** The trash reuses the note-row visuals but with restore/purge actions. */
export function renderTrashList(container: HTMLElement, onChanged: () => void): void {
  if (state.trash.length === 0) {
    container.replaceChildren(
      el(
        "div",
        { class: "empty" },
        el("div", { class: "empty__icon" }, icon("trash", 22)),
        el("div", { class: "empty__title" }, "回收站是空的"),
        el("div", { class: "empty__hint" }, "删除的笔记会先放在这里，随时可以还原。"),
      ),
    );
    return;
  }

  container.replaceChildren(
    ...state.trash.map((item) => {
      const isFolder = item.kind === "folder";
      return el(
        "div",
        { class: "list-row" },
        el(
          "div",
          { class: "spacer" },
          el(
            "div",
            { class: "note-row__title" },
            isFolder ? icon("folder", 14) : null,
            item.title || (isFolder ? "未命名文件夹" : "未命名笔记"),
          ),
          el("div", { class: "note-row__excerpt" }, trashSummary(item)),
          el(
            "div",
            { class: "note-row__meta" },
            el("span", { class: "note-row__folder" }, `删除时间：${fullTime(item.deletedAt)}`),
            item.folder ? el("span", { class: "note-row__folder" }, `来自 ${item.folder}`) : null,
          ),
        ),
        el(
          "div",
          { class: "list-row__actions" },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async () => {
                await actions.restoreFromTrash(item.id);
                onChanged();
              },
            },
            icon("restore", 14),
            "还原",
          ),
          el(
            "button",
            {
              class: "ibtn",
              type: "button",
              title: "彻底删除",
              onclick: async () => {
                const ok = await confirm({
                  title: "彻底删除",
                  message: isFolder
                    ? `文件夹「${item.title}」及其中的全部内容将被永久删除，此操作无法撤销。`
                    : `「${item.title}」将被永久删除，此操作无法撤销。`,
                  confirmLabel: "永久删除",
                  danger: true,
                });
                if (!ok) return;
                await actions.purgeTrashItem(item.id);
                onChanged();
              },
            },
            icon("trash", 14),
          ),
        ),
      );
    }),
  );
}

/** One line describing what a trash entry holds. */
function trashSummary(item: TrashItem): string {
  if (item.kind !== "folder") return item.excerpt || "空白笔记";
  const parts = [`${item.notes} 篇笔记`];
  if (item.files > 0) parts.push(`${item.files} 个附件`);
  return `文件夹 · ${parts.join(" · ")}`;
}
