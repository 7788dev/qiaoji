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
        const count = state.trash.length;
        const first = await confirm({
          title: "清空回收站",
          message: `将永久删除回收站中的 ${count} 个条目，此操作无法撤销。`,
          confirmLabel: "继续",
          danger: true,
        });
        if (!first) return;

        if (count >= 10) {
          const phrase = await prompt({
            title: "输入确认",
            label: "请输入“清空”以确认永久删除",
            placeholder: "清空",
            confirmLabel: "永久清空",
            validate: (value) => (value === "清空" ? null : "请输入“清空”"),
          });
          if (!phrase) return;
        } else {
          const second = await confirm({
            title: "再次确认永久清空",
            message: "删除后无法从巧记恢复。确定要继续吗？",
            confirmLabel: "永久清空",
            danger: true,
          });
          if (!second) return;
        }
        await actions.emptyTrash();
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
            "在编辑区右键或打开“更多 → 编辑操作”，即可给当前笔记添加标签。",
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
              title: `筛选「${tag.name}」`,
              style: { textAlign: "left", color: "var(--fg)" },
              onclick: () => {
                // Closing first, or the scope changes behind the scrim and the
                // dialog sits over a list the user cannot see.
                handle.close();
                actions.selectScope("tag", tag.name);
              },
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

  const handle = openModal({
    title: "标签管理",
    width: 520,
    body,
    onClose: unsubscribe,
  });
}
