import * as actions from "../actions";
import { el, icon } from "../lib/dom";
import { countWords, readingTime, tagColor } from "../lib/format";
import { activeTab, isDirty, state, subscribe } from "../store";
import { showMenu } from "./menu";
import { prompt } from "./modal";

export interface StatusbarHandlers {
  setMode: (mode: "edit" | "preview") => void;
}

export interface Statusbar {
  root: HTMLElement;
  setCursor: (line: number, column: number, selected: number) => void;
}

const SAVE_LABELS: Record<string, string> = {
  idle: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

export function createStatusbar(handlers: StatusbarHandlers): Statusbar {
  const cursor = el("span", { class: "statusbar__item" });
  const words = el("span", { class: "statusbar__item" });
  const reading = el("span", { class: "statusbar__item" });
  const tags = el("button", {
    class: "statusbar__item",
    type: "button",
    title: "编辑标签",
  });
  const save = el("span", { class: "statusbar__save statusbar__item" });

  const editButton = el(
    "button",
    {
      class: "statusbar__item",
      type: "button",
      title: "编辑模式  Ctrl+P",
      onclick: () => handlers.setMode("edit"),
    },
    icon("pencil", 12),
    "编辑",
  );

  const previewButton = el(
    "button",
    {
      class: "statusbar__item",
      type: "button",
      title: "预览模式  Ctrl+P",
      onclick: () => handlers.setMode("preview"),
    },
    icon("eye", 12),
    "预览",
  );

  const root = el(
    "footer",
    { class: "statusbar", role: "status" },
    cursor,
    words,
    reading,
    tags,
    el("div", { class: "spacer" }),
    save,
    editButton,
    previewButton,
  );

  let line = 1;
  let column = 1;
  let selected = 0;

  function paintCursor(): void {
    const tab = activeTab();
    if (!tab) {
      cursor.textContent = "";
      return;
    }
    cursor.textContent = selected > 0
      ? `行 ${line}，列 ${column}（已选 ${selected}）`
      : `行 ${line}，列 ${column}`;
  }

  function paintCounts(): void {
    const tab = activeTab();
    if (!tab) {
      words.textContent = "";
      reading.textContent = "";
      return;
    }
    const total = countWords(tab.content);
    words.textContent = `${total} 字`;
    reading.textContent = total > 0 ? readingTime(total) : "";
  }

  function paintTags(): void {
    const tab = activeTab();
    tags.hidden = !tab;
    if (!tab) return;

    tags.replaceChildren(
      icon("tag", 12),
      ...(tab.tags.length > 0
        ? tab.tags.map((name) =>
            el(
              "span",
              { style: { color: `var(--tag-${tagColor(name)})` } },
              name,
            ),
          )
        : [el("span", { style: { color: "var(--fg-faint)" } }, "添加标签")]),
    );
  }

  function paintSave(): void {
    const tab = activeTab();
    save.hidden = !tab;
    if (!tab) return;

    const status = state.saveState === "idle" && isDirty(tab) ? "dirty" : state.saveState;
    save.classList.toggle("is-dirty", status === "dirty" || status === "error");
    save.classList.toggle("is-saved", status === "saved");

    save.replaceChildren(
      status === "saving"
        ? el("span", { class: "spinner" })
        : icon(status === "error" ? "alert" : status === "dirty" ? "edit" : "check", 12),
      el("span", null, SAVE_LABELS[status] ?? ""),
    );
  }

  function paintMode(): void {
    const tab = activeTab();
    const previewing = tab?.mode === "preview";
    editButton.classList.toggle("is-active", Boolean(tab) && !previewing);
    previewButton.classList.toggle("is-active", Boolean(tab) && previewing);
    editButton.disabled = !tab;
    previewButton.disabled = !tab;
  }

  tags.addEventListener("click", () => {
    const tab = activeTab();
    if (!tab) return;
    const rect = tags.getBoundingClientRect();

    const existing = state.tags.filter((t) => !tab.tags.includes(t.name));
    showMenu(
      [
        ...tab.tags.map((name) => ({
          label: `移除「${name}」`,
          icon: "close",
          run: () => void actions.setTags(tab.path, tab.tags.filter((t) => t !== name)),
        })),
        ...(tab.tags.length > 0 ? (["separator"] as const) : []),
        ...existing.slice(0, 8).map((tag) => ({
          label: tag.name,
          icon: "tag",
          run: () => void actions.setTags(tab.path, [...tab.tags, tag.name]),
        })),
        {
          label: "新建标签…",
          icon: "plus",
          run: async () => {
            const name = await prompt({
              title: "添加标签",
              label: "标签名称",
              placeholder: "例如：灵感",
            });
            if (name) await actions.setTags(tab.path, [...tab.tags, name]);
          },
        },
      ],
      { x: rect.left, y: rect.top - 8 },
    );
  });

  function paintAll(): void {
    paintCursor();
    paintCounts();
    paintTags();
    paintSave();
    paintMode();
  }

  subscribe(["activeTabId", "tabs"], paintAll);
  subscribe(["saveState"], paintSave);
  paintAll();

  return {
    root,
    setCursor: (nextLine, nextColumn, nextSelected) => {
      line = nextLine;
      column = nextColumn;
      selected = nextSelected;
      paintCursor();
      paintCounts();
    },
  };
}
