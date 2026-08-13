import * as actions from "../actions";
import * as api from "../api";
import { el, icon } from "../lib/dom";
import { shortPath } from "../lib/format";
import { activeTab, state } from "../store";
import type { ExportFormat } from "../types";
import { openModal } from "./modal";
import { notify, reportError } from "./toast";

interface FormatSpec {
  id: ExportFormat;
  label: string;
  hint: string;
}

const FORMATS: FormatSpec[] = [
  { id: "md", label: "Markdown (.md)", hint: "原样保存源文件，适合备份与迁移" },
  { id: "html", label: "HTML (.html)", hint: "单文件自包含，公式与样式一并内嵌" },
  { id: "pdf", label: "PDF 文档 (.pdf)", hint: "用应用内排版引擎生成，与预览一致" },
  { id: "docx", label: "Word 文档 (.docx)", hint: "带标题层级与表格，可在 Word 中继续编辑" },
  { id: "txt", label: "纯文本 (.txt)", hint: "去掉所有标记，只保留文字" },
];

export interface ExportDeps {
  /** Supplies the rendered preview markup, so exports match what is on screen. */
  currentHtml: () => Promise<{ html: string; hasMath: boolean }>;
}

export function openExportDialog(deps: ExportDeps): void {
  const tab = activeTab();
  if (!tab) {
    notify.info("请先打开一篇笔记");
    return;
  }

  const title = actions.tabTitle(tab);
  let format: ExportFormat = (state.settings.lastExportFormat as ExportFormat) || "md";
  if (!FORMATS.some((f) => f.id === format)) format = "md";
  let dir = state.settings.exportDir;

  const nameInput = el("input", {
    class: "input",
    type: "text",
    value: title,
    spellcheck: false,
    "aria-label": "文件名",
  });

  const dirLabel = el("span", { class: "truncate" }, shortPath(dir || "未选择"));
  const dirButton = el(
    "button",
    {
      class: "btn",
      type: "button",
      style: { width: "100%", justifyContent: "space-between" },
      onclick: async () => {
        const picked = await api.selectExportDir().catch(() => "");
        if (!picked) return;
        dir = picked;
        dirLabel.textContent = shortPath(dir);
        dirLabel.title = dir;
      },
    },
    dirLabel,
    icon("folderOpen", 15),
  );
  dirLabel.title = dir;

  const hint = el("div", { class: "field__hint" });

  const formatList = el("div", { class: "export__formats" });

  function paintFormats(): void {
    formatList.replaceChildren(
      ...FORMATS.map((spec) =>
        el(
          "button",
          {
            class: `export__format${spec.id === format ? " is-active" : ""}`,
            type: "button",
            onclick: () => {
              format = spec.id;
              paintFormats();
            },
          },
          el("span", { class: "truncate" }, spec.label),
          spec.id === format ? icon("check", 14) : null,
        ),
      ),
    );
    hint.textContent = FORMATS.find((f) => f.id === format)?.hint ?? "";
  }
  paintFormats();

  const submit = el(
    "button",
    { class: "btn btn--primary", type: "button" },
    "导出",
  );

  let busy = false;
  submit.addEventListener("click", async () => {
    if (busy) return;
    if (!dir) {
      // The very first export has no remembered folder, so ask for one here
      // rather than refusing with an error the user cannot act on in place.
      const picked = await api.selectExportDir().catch(() => "");
      if (!picked) return;
      dir = picked;
      dirLabel.textContent = shortPath(dir);
      dirLabel.title = dir;
    }
    busy = true;
    submit.replaceChildren(el("span", { class: "spinner" }), "导出中…");
    submit.disabled = true;

    try {
      // PDF and HTML reuse the preview markup; the others work from source.
      const needsHtml = format === "pdf" || format === "html";
      const rendered = needsHtml
        ? await deps.currentHtml()
        : { html: "", hasMath: false };

      const path = await api.runExport({
        format,
        title,
        fileName: nameInput.value.trim() || title,
        dir,
        markdown: actions.currentMarkdown(),
        bodyHtml: rendered.html,
        hasMath: rendered.hasMath,
      });

      handle.close();
      notify.success(`已导出到 ${shortPath(path, 40)}`, {
        duration: 6000,
        action: { label: "打开", run: () => void api.openPath(path) },
      });
      await actions.patchSettings({ exportDir: dir, lastExportFormat: format });
    } catch (err) {
      reportError("导出失败", err);
    } finally {
      busy = false;
      submit.replaceChildren("导出");
      submit.disabled = false;
    }
  });

  const handle = openModal({
    title: "导出",
    width: 620,
    variant: "export-modal",
    body: el(
      "div",
      { class: "export__grid" },
      el(
        "div",
        { class: "export__left" },
        el("div", { class: "field__label" }, "导出为"),
        formatList,
      ),
      el(
        "div",
        { class: "export__right" },
        el("div", { class: "field__label" }, "导出设置"),
        el(
          "div",
          { class: "field" },
          el("label", { class: "field__label" }, "文件名"),
          nameInput,
        ),
        el(
          "div",
          { class: "field" },
          el("label", { class: "field__label" }, "保存位置"),
          dirButton,
        ),
        hint,
      ),
    ),
    footer: [
      el("button", { class: "btn", type: "button", onclick: () => handle.close() }, "取消"),
      submit,
    ],
    initialFocus: () => submit,
  });

  nameInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      submit.click();
    }
  });
}
