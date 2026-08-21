import * as actions from "../actions";
import * as api from "../api";
import { disposableElement, el, icon, on, type DisposableHTMLElement } from "../lib/dom";
import { fullTime, shortPath, tagColor } from "../lib/format";
import { activeTab, state, subscribe, setState } from "../store";
import type { Tab } from "../types";
import { notify, reportError } from "./toast";

export function createPropertyDrawer(): DisposableHTMLElement {
  const header = el(
    "div",
    { class: "property-drawer__head" },
    el("strong", null, "属性"),
    el(
      "button",
      {
        class: "ibtn ibtn--sm",
        type: "button",
        title: "关闭属性  Ctrl+Shift+I",
        "aria-label": "关闭属性",
        onclick: () => setState({ propertiesVisible: false }),
      },
      icon("close", 13),
    ),
  );
  const content = el("div", { class: "property-drawer__content scroll" });
  const root = el(
    "aside",
    {
      class: "property-drawer",
      "aria-label": "当前笔记属性",
      hidden: true,
    },
    header,
    content,
  );

  function paint(): void {
    root.hidden = !state.propertiesVisible;
    if (root.hidden) return;
    const tab = activeTab();
    if (!tab) {
      content.replaceChildren(
        el(
          "div",
          { class: "empty property-drawer__empty" },
          el("div", { class: "empty__icon" }, icon("info", 20)),
          el("div", { class: "empty__title" }, "没有打开的笔记"),
        ),
      );
      return;
    }
    content.replaceChildren(...paintMarkdown(tab));
  }

  function paintMarkdown(tab: Tab): HTMLElement[] {
    const favorite = el(
      "button",
      {
        class: `property-toggle${tab.favorite ? " is-active" : ""}`,
        type: "button",
        "aria-pressed": tab.favorite ? "true" : "false",
        onclick: () => void actions.toggleFavorite(tab.path),
      },
      icon("star", 15),
      el("span", null, tab.favorite ? "已收藏" : "加入收藏"),
    );

    const tags = el("div", { class: "property-tags" });
    for (const name of tab.tags) {
      const remove = el(
        "button",
        {
          class: "chip__remove",
          type: "button",
          title: `移除标签 ${name}`,
          "aria-label": `移除标签 ${name}`,
          onclick: () => void actions.setTags(tab.path, tab.tags.filter((tag) => tag !== name)),
        },
        icon("close", 10),
      );
      tags.appendChild(
        el(
          "span",
          { class: "chip" },
          el("span", { class: "chip__dot", style: { color: `var(--tag-${tagColor(name)})` } }),
          el("span", null, name),
          remove,
        ),
      );
    }

    const tagInput = el("input", {
      class: "input property-tags__input",
      type: "text",
      placeholder: "输入标签并按 Enter",
      "aria-label": "添加标签",
      onkeydown: (ev: KeyboardEvent) => {
        if (ev.key !== "Enter" && ev.key !== ",") return;
        ev.preventDefault();
        const input = ev.currentTarget as HTMLInputElement;
        const additions = input.value
          .split(/[,，]/)
          .map((value) => value.trim())
          .filter(Boolean);
        if (additions.length === 0) return;
        input.value = "";
        const next = Array.from(new Set([...tab.tags, ...additions]));
        void actions.setTags(tab.path, next);
      },
    }) as HTMLInputElement;

    const relativePath = vaultRelativePath(tab.path);
    const pathValue = el("div", { class: "property-path", title: tab.path }, shortPath(relativePath, 44));
    const status = statusBlock(tab.id, Boolean(tab.conflict));

    const sections = [
      section("笔记", favorite),
      section("标签", tags, tagInput),
      section(
        "位置",
        pathValue,
        el(
          "div",
          { class: "property-actions" },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => void api.revealInExplorer(tab.path),
            },
            icon("folderOpen", 13),
            "显示",
          ),
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => {
                void navigator.clipboard.writeText(tab.path).then(
                  () => notify.success("已复制文件路径"),
                  (err) => reportError("复制文件路径", err),
                );
              },
            },
            icon("copy", 13),
            "复制",
          ),
        ),
      ),
      section(
        "时间",
        propertyRow("创建", fullTime(tab.created)),
        propertyRow("修改", fullTime(tab.updated)),
      ),
    ];
    content.replaceChildren(...(status ? [status, ...sections] : sections));
    return [];
  }

  function statusBlock(id: string, conflict: boolean): HTMLElement | null {
    if (!conflict && state.saveState !== "error") return null;
    return el(
      "div",
      { class: `property-alert${conflict ? " is-conflict" : ""}` },
      icon("alert", 15),
      el(
        "div",
        { class: "spacer" },
        el("strong", null, conflict ? "磁盘版本发生冲突" : "保存失败"),
        el(
          "span",
          null,
          conflict ? "选择保留本机、磁盘或副本。" : "内容仍保留在编辑区，可以重试。",
        ),
      ),
      el(
        "button",
        { class: "btn", type: "button", onclick: () => void actions.saveTab(id) },
        conflict ? "处理" : "重试",
      ),
    );
  }

  function section(title: string, ...children: (Node | null)[]): HTMLElement {
    return el(
      "section",
      { class: "property-section" },
      el("h3", { class: "property-section__title" }, title),
      ...children,
    );
  }

  function propertyRow(label: string, value: string): HTMLElement {
    return el(
      "div",
      { class: "property-row" },
      el("span", { class: "property-row__label" }, label),
      el("span", { class: "property-row__value" }, value || "—"),
    );
  }

  function vaultRelativePath(path: string): string {
    const root = state.vaultPath.replace(/[\\/]+$/, "");
    if (root && path.toLocaleLowerCase().startsWith(root.toLocaleLowerCase())) {
      return path.slice(root.length).replace(/^[\\/]+/, "") || path;
    }
    return path;
  }

  const removeKeydown = on(root, "keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    setState({ propertiesVisible: false });
  });
  const unsubscribe = subscribe(
    ["propertiesVisible", "activeTabId", "tabs", "saveState", "vaultPath"],
    paint,
  );
  paint();

  return disposableElement(root, () => {
    unsubscribe();
    removeKeydown();
  });
}
