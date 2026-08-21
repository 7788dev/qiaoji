import * as actions from "../actions";
import { disposableElement, el, icon, on, type DisposableHTMLElement } from "../lib/dom";
import { tagColor } from "../lib/format";
import { state, subscribe } from "../store";
import type { Folder, Scope, Tag } from "../types";
import { showMenu } from "./menu";
import { confirm, prompt } from "./modal";
import { DRAG_TYPE } from "./notelist";

export interface SidebarHandlers {
  openTrash: () => void;
  openTags: () => void;
}

interface RowNode {
  root: HTMLButtonElement;
  icon: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
}

function setCount(node: HTMLElement, value: number): void {
  node.textContent = value > 0 ? String(value) : "";
  node.hidden = value <= 0;
}

export function createSidebar(handlers: SidebarHandlers): DisposableHTMLElement {
  const scroll = el("div", { class: "sidebar__scroll scroll" });
  const libraryRows = el("div", { class: "nav-group__rows" });
  const folderRows = el("div", { class: "nav-group__rows" });
  const tagRows = el("div", { class: "nav-group__rows" });

  const libraryGroup = el(
    "div",
    { class: "nav-group" },
    el("div", { class: "nav-group__head" }, el("span", { class: "nav-group__title" }, "笔记库")),
    libraryRows,
  );

  const folderGroup = el(
    "div",
    { class: "nav-group" },
    el(
      "div",
      { class: "nav-group__head" },
      el("span", { class: "nav-group__title" }, "文件夹"),
      el(
        "button",
        {
          class: "nav-group__add",
          type: "button",
          title: "新建文件夹",
          "aria-label": "新建文件夹",
          onclick: async () => {
            const name = await prompt({
              title: "新建文件夹",
              label: "文件夹名称",
              placeholder: "例如：工作",
            });
            if (name) await actions.createFolder(name);
          },
        },
        icon("plus", 14),
      ),
    ),
    folderRows,
  );

  let tagsExpanded = false;
  try {
    tagsExpanded = localStorage.getItem("qiaoji.tags-expanded") === "1";
  } catch {
    /* Local UI state is optional. */
  }
  const tagChevron = el("span", { class: "nav-group__chevron" }, icon("chevronRight", 12));
  const tagTotal = el("span", { class: "nav-group__meta" });
  const tagGroup = el(
    "div",
    { class: "nav-group nav-group--collapsible" },
    el(
      "div",
      { class: "nav-group__head" },
      el(
        "button",
        {
          class: "nav-group__title nav-group__toggle",
          type: "button",
          onclick: () => {
            tagsExpanded = !tagsExpanded;
            try {
              localStorage.setItem("qiaoji.tags-expanded", tagsExpanded ? "1" : "0");
            } catch {
              /* Local UI state is optional. */
            }
            syncTags();
          },
        },
        tagChevron,
        el("span", null, "标签"),
        tagTotal,
      ),
      el(
        "button",
        {
          class: "nav-group__add",
          type: "button",
          title: "管理标签",
          "aria-label": "管理标签",
          onclick: handlers.openTags,
        },
        icon("settings", 13),
      ),
    ),
    tagRows,
  );

  const trashNode = makeRow("trash", "回收站", () => handlers.openTrash());
  trashNode.root.dataset.scope = "trash";
  const root = el(
    "aside",
    { class: "sidebar", "aria-label": "笔记库导航" },
    scroll,
    el(
      "div",
      { class: "sidebar__foot" },
      trashNode.root,
    ),
  );
  scroll.append(libraryGroup, folderGroup, tagGroup);

  function makeRow(iconName: string, text: string, run: () => void): RowNode {
    const iconNode = el("span", { class: "nav-item__icon" }, icon(iconName, 15));
    const label = el("span", { class: "nav-item__label" }, text);
    const count = el("span", { class: "nav-item__count", hidden: true });
    const root = el(
      "button",
      { class: "nav-item", type: "button", onclick: run },
      iconNode,
      label,
      count,
    ) as HTMLButtonElement;
    return { root, icon: iconNode, label, count };
  }

  const librarySpecs: { scope: Scope; label: string; icon: string }[] = [
    { scope: "all", label: "全部笔记", icon: "notes" },
    { scope: "recent", label: "最近使用", icon: "clock" },
    { scope: "favorites", label: "收藏", icon: "star" },
  ];
  const libraryNodes = new Map<Scope, RowNode>();
  for (const spec of librarySpecs) {
    const node = makeRow(spec.icon, spec.label, () => actions.selectScope(spec.scope));
    node.root.dataset.scope = spec.scope;
    libraryNodes.set(spec.scope, node);
    libraryRows.appendChild(node.root);
  }

  const folderNodes = new Map<string, RowNode>();
  const tagNodes = new Map<string, RowNode>();

  function folderMenu(path: string, x: number, y: number): void {
    const folder = state.folders.find((entry) => entry.path === path);
    if (!folder) return;
    showMenu(
      [
        { label: "在此新建笔记", icon: "plus", run: () => void actions.newNote(path) },
        {
          label: "重命名",
          icon: "pencil",
          run: async () => {
            const name = await prompt({ title: "重命名文件夹", label: "文件夹名称", value: folder.name });
            if (name && name !== folder.name) await actions.renameFolder(path, name);
          },
        },
        "separator",
        {
          label: "删除文件夹",
          icon: "trash",
          danger: true,
          run: async () => {
            const ok = await confirm({
              title: "删除文件夹",
              message: `「${folder.name}」会整个移入回收站，其中的 ${folder.count} 篇笔记和所有附件都可以还原。`,
              confirmLabel: "移入回收站",
              danger: true,
            });
            if (ok) await actions.deleteFolder(path);
          },
        },
      ],
      { x, y },
    );
  }

  function createFolderRow(folder: Folder): RowNode {
    const node = makeRow("folder", folder.name, () => {
      const path = node.root.dataset.folder ?? "";
      actions.selectScope("folder", path);
    });
    node.root.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      folderMenu(node.root.dataset.folder ?? "", ev.clientX, ev.clientY);
    });
    return node;
  }

  function syncFolders(): void {
    const wanted = new Set(state.folders.map((folder) => folder.path));
    for (const [path, node] of folderNodes) {
      if (wanted.has(path)) continue;
      node.root.remove();
      folderNodes.delete(path);
    }

    let previous: Element | null = null;
    for (const folder of state.folders) {
      let node = folderNodes.get(folder.path);
      if (!node) {
        node = createFolderRow(folder);
        folderNodes.set(folder.path, node);
      }
      node.root.dataset.folder = folder.path;
      node.root.title = folder.path;
      node.label.textContent = folder.name;
      setCount(node.count, folder.count);
      const active = state.scope === "folder" && state.scopeValue === folder.path;
      node.root.classList.toggle("is-active", active);
      node.icon.replaceChildren(icon(active ? "folderOpen" : "folder", 15));
      const slot: Element | null = previous
        ? previous.nextElementSibling
        : folderRows.firstElementChild;
      if (slot !== node.root) folderRows.insertBefore(node.root, slot);
      previous = node.root;
    }

    if (state.folders.length === 0) {
      folderRows.replaceChildren(
        el("div", { class: "nav-empty" }, "还没有文件夹"),
      );
    } else {
      folderRows.querySelector(".nav-empty")?.remove();
    }
  }

  function tagMenu(name: string, x: number, y: number): void {
    const tag = state.tags.find((entry) => entry.name === name);
    if (!tag) return;
    showMenu(
      [
        {
          label: "重命名标签",
          icon: "pencil",
          run: async () => {
            const next = await prompt({ title: "重命名标签", label: "标签名称", value: tag.name });
            if (next && next !== tag.name) await actions.renameTag(tag.name, next);
          },
        },
        {
          label: "删除标签",
          icon: "trash",
          danger: true,
          run: async () => {
            const ok = await confirm({
              title: "删除标签",
              message: `将从 ${tag.count} 篇笔记中移除「${tag.name}」，笔记本身不会被删除。`,
              confirmLabel: "删除",
              danger: true,
            });
            if (ok) await actions.deleteTag(tag.name);
          },
        },
      ],
      { x, y },
    );
  }

  function createTagRow(tag: Tag): RowNode {
    const node = makeRow("tag", tag.name, () => {
      const name = node.root.dataset.tag ?? "";
      actions.selectScope("tag", name);
    });
    node.root.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      tagMenu(node.root.dataset.tag ?? "", ev.clientX, ev.clientY);
    });
    return node;
  }

  function syncTags(): void {
    tagGroup.hidden = state.tags.length === 0;
    tagChevron.replaceChildren(icon(tagsExpanded ? "chevronDown" : "chevronRight", 12));
    tagTotal.textContent = state.tags.length ? String(state.tags.length) : "";

    const activeTag = state.scope === "tag" ? state.scopeValue : "";
    const shown = tagsExpanded
      ? state.tags.slice(0, 8)
      : state.tags.filter((tag) => tag.name === activeTag);
    const wanted = new Set(shown.map((tag) => tag.name));
    for (const [name, node] of tagNodes) {
      if (!wanted.has(name)) node.root.remove();
    }

    let previous: Element | null = null;
    for (const tag of shown) {
      let node = tagNodes.get(tag.name);
      if (!node) {
        node = createTagRow(tag);
        tagNodes.set(tag.name, node);
      }
      node.root.dataset.tag = tag.name;
      node.label.textContent = tag.name;
      setCount(node.count, tag.count);
      const active = activeTag === tag.name;
      node.root.classList.toggle("is-active", active);
      node.icon.replaceChildren(el("span", { class: "nav-item__dot" }));
      node.icon.style.color = `var(--tag-${tagColor(tag.name)})`;
      const slot: Element | null = previous
        ? previous.nextElementSibling
        : tagRows.firstElementChild;
      if (slot !== node.root) tagRows.insertBefore(node.root, slot);
      previous = node.root;
    }

    tagRows.querySelector("[data-more-tags]")?.remove();
    if (tagsExpanded && state.tags.length > shown.length) {
      tagRows.appendChild(
        el(
          "button",
          {
            class: "nav-item",
            type: "button",
            dataset: { moreTags: "1" },
            onclick: handlers.openTags,
          },
          el("span", { class: "nav-item__icon" }, icon("more", 15)),
          el("span", { class: "nav-item__label" }, `还有 ${state.tags.length - shown.length} 个`),
        ),
      );
    }

    for (const [name, node] of tagNodes) {
      if (state.tags.some((tag) => tag.name === name)) continue;
      node.root.remove();
      tagNodes.delete(name);
    }
  }

  function paintScope(): void {
    for (const [scope, node] of libraryNodes) {
      node.root.classList.toggle("is-active", state.scope === scope);
    }
    trashNode.root.classList.toggle("is-active", state.scope === "trash");
    for (const [path, node] of folderNodes) {
      const active = state.scope === "folder" && state.scopeValue === path;
      node.root.classList.toggle("is-active", active);
      node.icon.replaceChildren(icon(active ? "folderOpen" : "folder", 15));
    }
    syncTags();
  }

  function paintStats(): void {
    const all = libraryNodes.get("all");
    if (all) setCount(all.count, state.stats.notes);
    setCount(trashNode.count, state.stats.trash);
  }

  enableFolderDrop(folderGroup);
  const unsubscribeFolders = subscribe(["folders"], syncFolders);
  const unsubscribeTags = subscribe(["tags"], syncTags);
  const unsubscribeStats = subscribe(["stats"], paintStats);
  const unsubscribeScope = subscribe(["scope", "scopeValue"], paintScope);
  syncFolders();
  syncTags();
  paintStats();
  paintScope();

  return disposableElement(root, () => {
    unsubscribeFolders();
    unsubscribeTags();
    unsubscribeStats();
    unsubscribeScope();
    folderNodes.clear();
    tagNodes.clear();
  });
}

function enableFolderDrop(group: HTMLElement): void {
  let current: HTMLElement | null = null;
  const setTarget = (node: HTMLElement | null) => {
    if (current === node) return;
    current?.classList.remove("is-drop-target");
    current = node;
    current?.classList.add("is-drop-target");
  };

  on(group, "dragover", (ev) => {
    const event = ev as DragEvent;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    if (!row) {
      setTarget(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setTarget(row);
  });
  on(group, "dragleave", (ev) => {
    const event = ev as DragEvent;
    if (!group.contains(event.relatedTarget as Node)) setTarget(null);
  });
  on(group, "drop", (ev) => {
    const event = ev as DragEvent;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-folder]");
    setTarget(null);
    if (!row) return;
    const path = event.dataTransfer?.getData(DRAG_TYPE);
    if (!path) return;
    event.preventDefault();
    void actions.moveNote(path, row.dataset.folder ?? "");
  });
}
