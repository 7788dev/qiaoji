import { el } from "../lib/dom";
import { preloadFor, render } from "../lib/markdown";
import * as api from "../api";
import { openModal } from "../ui/modal";
import { notify } from "../ui/toast";
import type { ExportFormat } from "../types";
import type { CloseChoice, WritingController } from "./controller";
import type { OpenDocument } from "./types";
import { splitSource } from "./source";

export function askClose(doc: OpenDocument): Promise<CloseChoice> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: CloseChoice) => {
      if (settled) return;
      settled = true;
      resolve(choice);
      modal.close();
    };
    const save = el("button", { class: "btn btn--primary", type: "button", onclick: () => finish("save") }, "保存");
    const modal = openModal({
      title: "保存修改？", width: 420, showCloseButton: false, closeOnBackdrop: false,
      body: el("p", { class: "dialog-copy" }, `“${doc.name}”有未保存的修改。`),
      footer: [
        el("button", { class: "btn", type: "button", onclick: () => finish("discard") }, "不保存"),
        el("span", { style: { flex: "1" } }),
        el("button", { class: "btn", type: "button", onclick: () => finish("cancel") }, "取消"),
        save,
      ],
      initialFocus: () => save,
      onClose: () => finish("cancel"),
    });
  });
}

function select(value: string, options: [string, string][], change: (value: string) => void): HTMLSelectElement {
  const field = el("select", { class: "input", onchange: (event: Event) => change((event.target as HTMLSelectElement).value) },
    ...options.map(([value, label]) => el("option", { value }, label)));
  field.value = value;
  return field;
}
function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = "setting-" + Math.random().toString(36).slice(2);
  control.id = id;
  return el("div", { class: "writing-setting" },
    el("div", null, el("label", { htmlFor: id }, label), hint && el("p", { class: "field__hint" }, hint)), control);
}

export function showSettings(controller: WritingController): void {
  const settings = controller.settings;
  const patch = (next: Parameters<WritingController["patchSettings"]>[0]) => void controller.patchSettings(next);
  const number = (value: number, min: number, max: number, step: number, change: (value: number) => void) =>
    el("input", { class: "input", type: "number", value: String(value), min, max, step,
      onchange: (event: Event) => {
        const input = event.target as HTMLInputElement;
        const next = Math.min(max, Math.max(min, Number(input.value) || value));
        input.value = String(next);
        change(next);
      } });
  const body = el("div", { class: "writing-settings" },
    row("主题", select(settings.theme, [["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]], (theme) => patch({ theme: theme as typeof settings.theme }))),
    row("正文字体", select(settings.fontFamily, [["system", "系统字体"], ["Microsoft YaHei", "微软雅黑"], ["SimSun", "宋体"], ["Georgia", "Georgia"], ["Cascadia Mono", "等宽字体"]], (fontFamily) => patch({ fontFamily }))),
    row("正文字号（px）", number(settings.fontSize, 10, 32, 1, (fontSize) => patch({ fontSize })), "默认 16px，标题随正文按比例显示。"),
    row("行高", number(settings.lineHeight, 1.2, 2.5, 0.05, (lineHeight) => patch({ lineHeight }))),
    row("正文宽度", select(settings.editorWidth, [["narrow", "窄"], ["medium", "标准"], ["wide", "宽"], ["full", "填满"]], (width) => patch({ editorWidth: width as typeof settings.editorWidth }))),
    row("应用缩放", select(String(settings.zoom), [["50", "50%"], ["75", "75%"], ["100", "100%（默认）"], ["125", "125%"], ["150", "150%"], ["175", "175%"], ["200", "200%"]], (value) => patch({ zoom: Number(value) })), "同时调整菜单与正文。正常使用建议 100%。"),
    row("保存方式", select(settings.autoSave ? "auto" : "manual", [["manual", "手动保存"], ["auto", "自动保存"]], (value) => patch({ autoSave: value === "auto" })), "手动保存使用 Ctrl+S；新文档第一次保存时选择位置。"),
    row("源码行号", select(settings.showLineNumbers ? "yes" : "no", [["no", "隐藏"], ["yes", "显示"]], (value) => patch({ showLineNumbers: value === "yes" }))),
    row("关闭窗口", select(settings.closeToTray ? "tray" : "exit", [["exit", "退出应用"], ["tray", "保留在托盘"]], (value) => patch({ closeToTray: value === "tray" }))),
    row("启动时检查更新", select(settings.autoUpdate ? "yes" : "no", [["yes", "开启"], ["no", "关闭"]], (value) => patch({ autoUpdate: value === "yes" }))),
  );
  openModal({ title: "设置", width: 520, body });
}

export async function checkUpdates(silent = false): Promise<void> {
  try {
    const info = await api.checkForUpdates();
    if (info.available) {
      notify.success("发现新版本 " + info.latestVersion, {
        action: { label: "查看版本", run: () => void api.openExternal(info.releaseUrl) },
      });
    } else if (!silent) {
      notify.success(info.currentVersion === "dev" ? "当前为开发版本，最新发布为 " + info.latestVersion : "已是最新版本");
    }
  } catch (error) {
    if (!silent) notify.error("无法检查更新：" + String(error));
  }
}

const shortcuts = [
  ["新建文档", "Ctrl+N"], ["打开文件", "Ctrl+O"], ["打开文件夹", "Ctrl+Shift+O"],
  ["保存", "Ctrl+S"], ["另存为", "Ctrl+Shift+S"], ["关闭文档", "Ctrl+W"],
  ["切换文档", "Ctrl+Tab"], ["查找 / 替换", "Ctrl+F / Ctrl+H"],
  ["搜索文件夹", "Ctrl+Shift+F"], ["切换源码", "Ctrl+/"], ["显示 / 隐藏侧栏", "Ctrl+\\"],
  ["加粗 / 斜体", "Ctrl+B / Ctrl+I"], ["标题", "Ctrl+1 … Ctrl+6"], ["设置", "Ctrl+,"],
  ["恢复 100% 缩放", "Ctrl+Alt+0"],
];
export function showShortcuts(): void {
  openModal({ title: "快捷键", width: 520, body: el("div", { class: "writing-shortcuts" },
    ...shortcuts.map(([label, keys]) => el("div", null, el("span", null, label), el("kbd", null, keys)))) });
}
export function showSyntax(): void {
  const samples = [
    ["# 标题", "输入井号和空格，开始写标题。"], ["**加粗** / *斜体*", "输入 Markdown 标记后直接呈现排版。"],
    ["- 列表 / 1. 列表 / - [ ] 待办", "回车继续列表，空项再次回车结束列表。"],
    ["[文字](链接) / ![说明](图片)", "也可以从格式菜单插入链接、图片和表格。"],
    ["```语言", "创建代码块，选择语言后自动高亮。"], ["$公式$ / $$公式$$", "分别用于行内公式和独立公式。"],
  ];
  openModal({ title: "Markdown 入门", width: 540, body: el("div", { class: "writing-help" },
    ...samples.map(([code, description]) => el("div", null, el("code", null, code), el("p", null, description)))) });
}

async function renderedDocument(controller: WritingController, doc: OpenDocument): Promise<{ html: string; hasMath: boolean }> {
  const body = splitSource(doc.content).body;
  await preloadFor(body);
  const rendered = render(body);
  const template = document.createElement("template");
  template.innerHTML = rendered.html;
  await Promise.all(Array.from(template.content.querySelectorAll("img")).map(async (img) => {
    const source = img.getAttribute("src") ?? "";
    if (/^https?:\/\//i.test(source)) return;
    const url = await controller.bridge.assetURL(doc.id, source, doc.content);
    const response = await fetch(url);
    if (!response.ok) throw new Error("无法读取图片：" + source);
    const blob = await response.blob();
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    img.src = data;
  }));
  return { html: template.innerHTML, hasMath: rendered.hasMath };
}

export function showExport(controller: WritingController): void {
  controller.flush();
  const doc = controller.active;
  if (!doc) return;
  let format: ExportFormat = ["pdf", "html", "docx", "txt"].includes(controller.settings.lastExportFormat)
    ? controller.settings.lastExportFormat as ExportFormat : "pdf";
  let dir = controller.settings.exportDir;
  const fileName = el("input", { class: "input", value: doc.name.replace(/\.(?:md|markdown)$/i, ""), "aria-label": "导出文件名" });
  const location = el("button", { class: "btn export-location", type: "button", title: dir, onclick: async () => {
    const picked = await controller.bridge.selectExportDir();
    if (picked) { dir = picked; location.textContent = dir; location.title = dir; }
  } }, dir || "选择保存位置");
  const submit = el("button", { class: "btn btn--primary", type: "button" }, "导出");
  const modal = openModal({
    title: "导出文档", width: 500,
    body: el("div", { class: "writing-settings" },
      row("格式", select(format, [["pdf", "PDF"], ["html", "HTML"], ["docx", "Word"], ["txt", "纯文本"]], (value) => { format = value as ExportFormat; })),
      row("文件名", fileName), row("保存位置", location)),
    footer: [el("button", { class: "btn", type: "button", onclick: () => modal.close() }, "取消"), submit],
  });
  submit.onclick = async () => {
    if (submit.disabled) return;
    submit.disabled = true;
    submit.textContent = "导出中…";
    try {
      controller.flush(doc.id);
      if (!dir) dir = await controller.bridge.selectExportDir();
      if (!dir) return;
      const rendered = format === "html" || format === "pdf" ? await renderedDocument(controller, doc) : { html: "", hasMath: false };
      const result = await controller.bridge.exportDocument({
        format, title: doc.name.replace(/\.(?:md|markdown)$/i, ""), fileName: fileName.value || "未命名",
        dir, markdown: splitSource(doc.content).body, bodyHtml: rendered.html, hasMath: rendered.hasMath,
      });
      await controller.patchSettings({ exportDir: dir, lastExportFormat: format });
      modal.close();
      notify.success("已导出", { action: { label: "打开", run: () => void api.openPath(result) } });
    } catch (error) { controller.dialogs.error(String(error)); }
    finally { submit.disabled = false; submit.textContent = "导出"; }
  };
}

export async function showTrash(controller: WritingController): Promise<void> {
  const id = controller.active?.id ?? "";
  const entries = await controller.bridge.listTrash(id);
  const list = el("div", { class: "writing-trash" });
  if (!entries.length) list.append(el("p", { class: "quiet-copy" }, "回收站是空的。"));
  for (const entry of entries) {
    const item = el("div", { class: "writing-trash__row" }, el("span", { title: entry.originalRel }, entry.title),
      el("button", { class: "btn", type: "button", onclick: async () => {
        try {
          const result = await controller.bridge.restoreTrash(entry.root, entry.id);
          item.remove();
          controller.emit("folder");
          if (result.kind === "note") await controller.open(result.note.path);
          if (!list.children.length) list.append(el("p", { class: "quiet-copy" }, "回收站是空的。"));
        } catch (error) { controller.dialogs.error(String(error)); }
      } }, "还原"));
    list.append(item);
  }
  openModal({ title: "回收站", width: 540, body: list });
}
