import * as actions from "../actions";
import { el, icon } from "../lib/dom";
import { tagColor } from "../lib/format";
import { renderTrashList } from "./notelist";
import { state, subscribe } from "../store";
import { confirm, openModal, prompt } from "./modal";

/* ---------------------------------------------------------------- trash */

export function openTrashDialog(): void {
  const body = el("div", { class: "trash__list" });

  const emptyButton = el(
    "button",
    {
      class: "btn btn--danger",
      type: "button",
      onclick: async () => {
        const ok = await confirm({
          title: "清空回收站",
          message: `将永久删除 ${state.trash.length} 篇笔记，此操作无法撤销。`,
          confirmLabel: "永久清空",
          danger: true,
        });
        if (ok) await actions.emptyTrash();
      },
    },
    icon("trash", 14),
    "清空回收站",
  );

  function paint(): void {
    renderTrashList(body, () => undefined);
    emptyButton.disabled = state.trash.length === 0;
  }

  const unsubscribe = subscribe(["trash"], paint);
  void actions.refreshTrash();
  paint();

  openModal({
    title: "回收站",
    width: 620,
    body,
    footer: [emptyButton],
    onClose: unsubscribe,
  });
}

/* ---------------------------------------------------------------- tags */

export function openTagsDialog(): void {
  const body = el("div", { class: "tags__list" });

  function paint(): void {
    if (state.tags.length === 0) {
      body.replaceChildren(
        el(
          "div",
          { class: "empty" },
          el("div", { class: "empty__icon" }, icon("tag", 22)),
          el("div", { class: "empty__title" }, "还没有标签"),
          el(
            "div",
            { class: "empty__hint" },
            "在状态栏点击标签图标，就能给当前笔记添加标签。",
          ),
        ),
      );
      return;
    }

    body.replaceChildren(
      ...state.tags.map((tag) =>
        el(
          "div",
          { class: "list-row" },
          el(
            "span",
            { style: { color: `var(--tag-${tagColor(tag.name)})`, display: "grid" } },
            el("span", { class: "nav-item__dot" }),
          ),
          el(
            "button",
            {
              class: "spacer truncate",
              type: "button",
              style: { textAlign: "left", color: "var(--fg)" },
              onclick: () => actions.selectScope("tag", tag.name),
            },
            tag.name,
          ),
          el("span", { class: "nav-item__count" }, `${tag.count} 篇`),
          el(
            "div",
            { class: "list-row__actions" },
            el(
              "button",
              {
                class: "ibtn ibtn--sm",
                type: "button",
                title: "重命名",
                onclick: async () => {
                  const name = await prompt({
                    title: "重命名标签",
                    label: "标签名称",
                    value: tag.name,
                  });
                  if (name && name !== tag.name) await actions.renameTag(tag.name, name);
                },
              },
              icon("pencil", 14),
            ),
            el(
              "button",
              {
                class: "ibtn ibtn--sm",
                type: "button",
                title: "删除",
                onclick: async () => {
                  const ok = await confirm({
                    title: "删除标签",
                    message: `将从 ${tag.count} 篇笔记中移除「${tag.name}」，笔记本身不会被删除。`,
                    confirmLabel: "删除",
                    danger: true,
                  });
                  if (ok) await actions.deleteTag(tag.name);
                },
              },
              icon("trash", 14),
            ),
          ),
        ),
      ),
    );
  }

  const unsubscribe = subscribe(["tags"], paint);
  paint();

  openModal({
    title: "标签管理",
    width: 520,
    body,
    onClose: unsubscribe,
  });
}
