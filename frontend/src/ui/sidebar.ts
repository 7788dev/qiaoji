import * as actions from "../actions";
import { el, icon, on } from "../lib/dom";
import { tagColor } from "../lib/format";
import { state, subscribe } from "../store";
import type { Scope } from "../types";
import { showMenu } from "./menu";
import { confirm, prompt } from "./modal";
import { DRAG_TYPE } from "./notelist";

export interface SidebarHandlers {
  openTrash: () => void;
  openTags: () => void;
  openSettings: () => void;
}

interface NavSpec {
  scope: Scope;
  value?: string;
  label: string;
  iconName: string;
  count?: number;
}

export function createSidebar(handlers: SidebarHandlers): HTMLElement {
  const scroll = el("div", { class: "sidebar__scroll scroll" });

  const root = el(
    "aside",
    { class: "sidebar", "aria-label": "笔记库导航" },
    scroll,
    el(
      "div",
      { class: "sidebar__foot" },
      navButton(
        { scope: "trash", label: "回收站", iconName: "trash" },
        () => handlers.openTrash(),
        () => state.stats.trash,
      ),
    ),
  );

  function navButton(
    spec: NavSpec,
    run: () => void,
    count?: () => number | undefined,
  ): HTMLElement {
    const active =
      state.scope === spec.scope && (spec.value ?? "") === (spec.scope === "folder" || spec.scope === "tag" ? state.scopeValue : "");
    const total = count?.();

    return el(
      "button",
      {
        class: `nav-item${active ? " is-active" : ""}`,
        type: "button",
        onclick: run,
        dataset: { scope: spec.scope, value: spec.value ?? "" },
      },
      el("span", { class: "nav-item__icon" }, icon(spec.iconName, 15)),
      el("span", { class: "nav-item__label" }, spec.label),
      total ? el("span", { class: "nav-item__count" }, String(total)) : null,
    );
  }

  function libraryGroup(): HTMLElement {
    const items: NavSpec[] = [
      { scope: "all", label: "全部笔记", iconName: "notes", count: state.stats.notes },
      { scope: "recent", label: "最近使用", iconName: "clock" },
      { scope: "favorites", label: "收藏", iconName: "star" },
    ];
    return el(
      "div",
      { class: "nav-group" },
      el(
        "div",
        { class: "nav-group__head" },
        el("span", { class: "nav-group__title" }, "笔记库"),
      ),
      ...items.map((spec) =>
        navButton(spec, () => actions.selectScope(spec.scope, ""), () => spec.count),
      ),
    );
  }

  function folderGroup(): HTMLElement {
    const add = el(
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
    );

    const rows = state.folders.map((folder) => {
      const active = state.scope === "folder" && state.scopeValue === folder.path;
      return el(
        "button",
        {
          class: `nav-item${active ? " is-active" : ""}`,
          type: "button",
          title: folder.path,
          dataset: { folder: folder.path },
          onclick: () => actions.selectScope("folder", folder.path),
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            showMenu(
              [
                {
                  label: "在此新建笔记",
                  icon: "plus",
                  run: () => void actions.newNote(folder.path),
                },
                {
                  label: "重命名",
                  icon: "pencil",
                  run: async () => {
                    const name = await prompt({
                      title: "重命名文件夹",
                      label: "文件夹名称",
                      value: folder.name,
                    });
                    if (name && name !== folder.name) {
                      await actions.renameFolder(folder.path, name);
                    }
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
                      message: `「${folder.name}」中的 ${folder.count} 篇笔记会移入回收站，可以随时还原。`,
                      confirmLabel: "删除",
                      danger: true,
                    });
                    if (ok) await actions.deleteFolder(folder.path);
                  },
                },
              ],
              { x: ev.clientX, y: ev.clientY },
            );
          },
        },
        el("span", { class: "nav-item__icon" }, icon(active ? "folderOpen" : "folder", 15)),
        el("span", { class: "nav-item__label" }, folder.name),
        folder.count ? el("span", { class: "nav-item__count" }, String(folder.count)) : null,
      );
    });

    const group = el(
      "div",
      { class: "nav-group" },
      el(
        "div",
        { class: "nav-group__head" },
        el("span", { class: "nav-group__title" }, "文件夹"),
        add,
      ),
      ...rows,
      rows.length === 0
        ? el(
            "div",
            {
              class: "nav-item",
              style: { color: "var(--fg-faint)", cursor: "default" },
            },
            el("span", { class: "nav-item__label" }, "还没有文件夹"),
          )
        : null,
    );

    enableFolderDrop(group);
    return group;
  }

  function tagGroup(): HTMLElement {
    if (state.tags.length === 0) return el("div", { hidden: true });

    const shown = state.tags.slice(0, 8);
    const rows = shown.map((tag) => {
      const active = state.scope === "tag" && state.scopeValue === tag.name;
      return el(
        "button",
        {
          class: `nav-item${active ? " is-active" : ""}`,
          type: "button",
          onclick: () => actions.selectScope("tag", tag.name),
          oncontextmenu: (ev: MouseEvent) => {
            ev.preventDefault();
            showMenu(
              [
                {
                  label: "重命名标签",
                  icon: "pencil",
                  run: async () => {
                    const name = await prompt({
                      title: "重命名标签",
                      label: "标签名称",
                      value: tag.name,
                    });
                    if (name && name !== tag.name) await actions.renameTag(tag.name, name);
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
              { x: ev.clientX, y: ev.clientY },
            );
          },
        },
        el(
          "span",
          { class: "nav-item__icon", style: { color: `var(--tag-${tagColor(tag.name)})` } },
          el("span", { class: "nav-item__dot" }),
        ),
        el("span", { class: "nav-item__label" }, tag.name),
        el("span", { class: "nav-item__count" }, String(tag.count)),
      );
    });

    return el(
      "div",
      { class: "nav-group" },
      el(
        "div",
        { class: "nav-group__head" },
        el("span", { class: "nav-group__title" }, "标签"),
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
      ...rows,
      state.tags.length > shown.length
        ? el(
            "button",
            {
              class: "nav-item",
              type: "button",
              onclick: handlers.openTags,
              style: { color: "var(--fg-muted)" },
            },
            el("span", { class: "nav-item__icon" }, icon("more", 15)),
            el("span", { class: "nav-item__label" }, `还有 ${state.tags.length - shown.length} 个`),
          )
        : null,
    );
  }

  function paint(): void {
    scroll.replaceChildren(libraryGroup(), folderGroup(), tagGroup());
    const foot = root.querySelector(".sidebar__foot");
    if (foot) {
      foot.replaceChildren(
        navButton(
          { scope: "trash", label: "回收站", iconName: "trash" },
          () => handlers.openTrash(),
          () => state.stats.trash,
        ),
      );
    }
  }

  subscribe(["folders", "tags", "stats", "scope", "scopeValue"], paint);
  paint();

  return root;
}

/**
 * Lets a note row be dropped onto a folder to move it. The drag payload is the
 * note path, set by the note list.
 */
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
