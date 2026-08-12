import * as actions from "../actions";
import * as api from "../api";
import { el, icon } from "../lib/dom";
import { fileSize, shortPath } from "../lib/format";
import { state, subscribe } from "../store";
import type { EditorWidth, Settings, ThemeName } from "../types";
import { confirm, openModal } from "./modal";
import { brandMark } from "./titlebar";
import { notify, reportError } from "./toast";

export interface SettingsDeps {
  openShortcuts: () => void;
  openAbout: () => void;
  setTheme: (theme: ThemeName) => void;
}

type SectionId = "general" | "editor" | "appearance" | "shortcuts" | "export" | "about";

interface Section {
  id: SectionId;
  label: string;
  icon: string;
}

const SECTIONS: Section[] = [
  { id: "general", label: "通用", icon: "settings" },
  { id: "editor", label: "编辑器", icon: "pencil" },
  { id: "appearance", label: "外观", icon: "sun" },
  { id: "shortcuts", label: "快捷键", icon: "keyboard" },
  { id: "export", label: "导出", icon: "download" },
  { id: "about", label: "关于", icon: "info" },
];

export function openSettings(deps: SettingsDeps, initial: SectionId = "general"): void {
  let current: SectionId = initial;

  const nav = el("nav", { class: "settings__nav" });
  const panel = el("div", { class: "settings__panel scroll" });

  function paintNav(): void {
    nav.replaceChildren(
      ...SECTIONS.map((section) =>
        el(
          "button",
          {
            class: `nav-item${section.id === current ? " is-active" : ""}`,
            type: "button",
            onclick: () => {
              current = section.id;
              paintNav();
              paintPanel();
            },
          },
          el("span", { class: "nav-item__icon" }, icon(section.icon, 15)),
          el("span", { class: "nav-item__label" }, section.label),
        ),
      ),
    );
  }

  function update(patch: Partial<Settings>): void {
    void actions.patchSettings(patch);
  }

  /* ------------------------------------------------------------ controls */

  function toggle(
    title: string,
    desc: string,
    value: boolean,
    onChange: (next: boolean) => void,
  ): HTMLElement {
    const box = el("span", { class: "check__box" }, icon("check", 12));
    const input = el("input", { type: "checkbox", checked: value });
    input.addEventListener("change", () => onChange(input.checked));

    return el(
      "label",
      { class: "setting-row", style: { cursor: "default" } },
      el(
        "div",
        { class: "setting-row__text" },
        el("div", { class: "setting-row__title" }, title),
        desc ? el("div", { class: "setting-row__desc" }, desc) : null,
      ),
      el("span", { class: "check setting-row__control setting-row__control--auto" }, input, box),
    );
  }

  function selectRow<T extends string | number>(
    title: string,
    desc: string,
    value: T,
    options: { value: T; label: string }[],
    onChange: (next: T) => void,
  ): HTMLElement {
    const select = el(
      "select",
      { class: "select" },
      ...options.map((opt) =>
        el("option", { value: String(opt.value), selected: opt.value === value }, opt.label),
      ),
    );
    select.addEventListener("change", () => {
      const raw = select.value;
      const match = options.find((opt) => String(opt.value) === raw);
      if (match) onChange(match.value);
    });

    return el(
      "div",
      { class: "setting-row" },
      el(
        "div",
        { class: "setting-row__text" },
        el("div", { class: "setting-row__title" }, title),
        desc ? el("div", { class: "setting-row__desc" }, desc) : null,
      ),
      el("div", { class: "setting-row__control" }, select),
    );
  }

  function sliderRow(
    title: string,
    desc: string,
    value: number,
    min: number,
    max: number,
    step: number,
    format: (n: number) => string,
    onChange: (next: number) => void,
  ): HTMLElement {
    const output = el("span", { class: "setting-row__value" }, format(value));
    const input = el("input", {
      type: "range",
      class: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    });
    input.addEventListener("input", () => {
      output.textContent = format(Number(input.value));
    });
    input.addEventListener("change", () => onChange(Number(input.value)));

    return el(
      "div",
      { class: "setting-row" },
      el(
        "div",
        { class: "setting-row__text" },
        el("div", { class: "setting-row__title" }, title),
        desc ? el("div", { class: "setting-row__desc" }, desc) : null,
      ),
      el("div", { class: "setting-row__control setting-row__range" }, input, output),
    );
  }

  /* ------------------------------------------------------------ sections */

  function generalSection(): HTMLElement {
    const s = state.settings;
    return el(
      "div",
      null,
      el("h3", { class: "settings__heading" }, "通用设置"),
      toggle("开机启动", "登录 Windows 后在后台启动，最小化到系统托盘", s.autostart, (v) =>
        update({ autostart: v }),
      ),
      toggle("最小化到系统托盘", "点击最小化时隐藏窗口而不是缩到任务栏", s.minimiseToTray, (v) =>
        update({ minimiseToTray: v }),
      ),
      toggle("关闭时最小化到托盘", "点击关闭按钮时保持后台运行", s.closeToTray, (v) =>
        update({ closeToTray: v }),
      ),
      toggle("自动检查更新", "启动时在后台检查新版本", s.autoUpdate, (v) =>
        update({ autoUpdate: v }),
      ),
      toggle(
        "硬件加速",
        "关闭后改用软件渲染。只有在界面出现黑块或文字撕裂时才需要关闭，重启后生效。",
        s.hardwareAcceleration,
        (v) => {
          update({ hardwareAcceleration: v });
          notify.info("重启巧记后生效");
        },
      ),
      selectRow(
        "语言",
        "",
        s.language,
        [{ value: "zh-CN", label: "简体中文" }],
        (v) => update({ language: v }),
      ),
      el("h3", { class: "settings__heading" }, "笔记库"),
      el(
        "div",
        { class: "setting-row" },
        el(
          "div",
          { class: "setting-row__text" },
          el("div", { class: "setting-row__title" }, "存储位置"),
          el(
            "div",
            { class: "setting-row__desc", title: state.vaultPath },
            shortPath(state.vaultPath, 58),
          ),
        ),
        el(
          "div",
          { class: "setting-row__control setting-row__control--auto", style: { display: "flex", gap: "var(--sp-2)" } },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              title: "在资源管理器中打开",
              onclick: () => void api.revealInExplorer(state.vaultPath),
            },
            icon("folderOpen", 14),
            "打开",
          ),
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async () => {
                const dir = await api.selectVaultDir().catch(() => "");
                if (!dir || dir === state.vaultPath) return;
                const ok = await confirm({
                  title: "切换笔记库",
                  message: `将改用「${dir}」作为笔记库。当前笔记不会被移动或删除，随时可以切换回来。`,
                  confirmLabel: "切换",
                });
                if (!ok) return;
                try {
                  const next = await api.openVault(dir);
                  await actions.adoptVault(next);
                  notify.success("已切换笔记库");
                  paintPanel();
                } catch (err) {
                  reportError("切换笔记库", err);
                }
              },
            },
            "更改",
          ),
        ),
      ),
      el(
        "div",
        { class: "setting-row" },
        el(
          "div",
          { class: "setting-row__text" },
          el("div", { class: "setting-row__title" }, "重建搜索索引"),
          el(
            "div",
            { class: "setting-row__desc" },
            "搜索结果和实际笔记对不上时使用。索引是可丢弃的缓存，笔记本身不受影响。",
          ),
        ),
        el(
          "div",
          { class: "setting-row__control setting-row__control--auto" },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async (ev: MouseEvent) => {
                const button = ev.currentTarget as HTMLButtonElement;
                button.disabled = true;
                button.replaceChildren(el("span", { class: "spinner" }), "重建中…");
                try {
                  const stats = await api.rebuildIndex();
                  await actions.refreshAll();
                  notify.success(`已重建索引，共 ${stats.notes} 篇笔记`);
                } catch (err) {
                  reportError("重建索引", err);
                } finally {
                  button.disabled = false;
                  button.replaceChildren(icon("refresh", 14), "重建");
                }
              },
            },
            icon("refresh", 14),
            "重建",
          ),
        ),
      ),
    );
  }

  function editorSection(): HTMLElement {
    const s = state.settings;
    return el(
      "div",
      null,
      el("h3", { class: "settings__heading" }, "编辑体验"),
      toggle("自动保存", "停止输入后自动写入磁盘", s.autoSave, (v) => update({ autoSave: v })),
      sliderRow(
        "自动保存延迟",
        "停止输入多久后写盘",
        s.autoSaveDelayMs,
        200,
        3000,
        100,
        (n) => `${(n / 1000).toFixed(1)} 秒`,
        (v) => update({ autoSaveDelayMs: v }),
      ),
      toggle("显示行号", "在编辑区左侧显示行号", s.showLineNumbers, (v) =>
        update({ showLineNumbers: v }),
      ),
      toggle("括号自动匹配", "高亮成对的括号与引号", s.autoPairing, (v) =>
        update({ autoPairing: v }),
      ),
      selectRow(
        "缩进宽度",
        "Tab 键插入的空格数",
        s.tabSize,
        [2, 4, 8].map((n) => ({ value: n, label: `${n} 个空格` })),
        (v) => update({ tabSize: v }),
      ),
    );
  }

  function appearanceSection(): HTMLElement {
    const s = state.settings;
    return el(
      "div",
      null,
      el("h3", { class: "settings__heading" }, "主题"),
      el(
        "div",
        { class: "setting-row" },
        el(
          "div",
          { class: "setting-row__text" },
          el("div", { class: "setting-row__title" }, "外观"),
          el("div", { class: "setting-row__desc" }, "跟随系统会随 Windows 的深浅色设置切换"),
        ),
        el(
          "div",
          { class: "setting-row__control setting-row__control--auto" },
          el(
            "div",
            { class: "segmented" },
            ...([
              { id: "light", label: "浅色" },
              { id: "dark", label: "深色" },
              { id: "system", label: "跟随系统" },
            ] as const).map((opt) =>
              el(
                "button",
                {
                  class: s.theme === opt.id ? "is-active" : "",
                  type: "button",
                  onclick: () => {
                    deps.setTheme(opt.id);
                    paintPanel();
                  },
                },
                opt.label,
              ),
            ),
          ),
        ),
      ),
      el("h3", { class: "settings__heading" }, "排版"),
      sliderRow(
        "正文字号",
        "同时影响编辑区与预览",
        s.fontSize,
        12,
        24,
        1,
        (n) => `${n}px`,
        (v) => update({ fontSize: v }),
      ),
      sliderRow(
        "行高",
        "中文阅读推荐 1.8 左右",
        s.lineHeight,
        1.4,
        2.4,
        0.1,
        (n) => n.toFixed(1),
        (v) => update({ lineHeight: v }),
      ),
      selectRow<EditorWidth>(
        "编辑区宽度",
        "较窄的行宽更利于长时间阅读",
        s.editorWidth,
        [
          { value: "narrow", label: "窄" },
          { value: "medium", label: "适中" },
          { value: "wide", label: "宽" },
          { value: "full", label: "铺满" },
        ],
        (v) => update({ editorWidth: v }),
      ),
      sliderRow(
        "界面缩放",
        "整体放大或缩小界面元素",
        s.zoom,
        80,
        150,
        10,
        (n) => `${n}%`,
        (v) => update({ zoom: v }),
      ),
    );
  }

  function shortcutsSection(): HTMLElement {
    return el(
      "div",
      null,
      el("h3", { class: "settings__heading" }, "快捷键"),
      el(
        "div",
        { class: "setting-row" },
        el(
          "div",
          { class: "setting-row__text" },
          el("div", { class: "setting-row__title" }, "查看全部快捷键"),
          el("div", { class: "setting-row__desc" }, "也可以随时按 Ctrl + / 打开"),
        ),
        el(
          "div",
          { class: "setting-row__control setting-row__control--auto" },
          el(
            "button",
            { class: "btn", type: "button", onclick: deps.openShortcuts },
            icon("keyboard", 14),
            "打开",
          ),
        ),
      ),
    );
  }

  function exportSection(): HTMLElement {
    const s = state.settings;
    return el(
      "div",
      null,
      el("h3", { class: "settings__heading" }, "导出"),
      el(
        "div",
        { class: "setting-row" },
        el(
          "div",
          { class: "setting-row__text" },
          el("div", { class: "setting-row__title" }, "默认保存位置"),
          el("div", { class: "setting-row__desc", title: s.exportDir }, shortPath(s.exportDir)),
        ),
        el(
          "div",
          { class: "setting-row__control setting-row__control--auto" },
          el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async () => {
                const dir = await api.selectExportDir().catch(() => "");
                if (dir) {
                  update({ exportDir: dir });
                  paintPanel();
                }
              },
            },
            icon("folderOpen", 14),
            "更改",
          ),
        ),
      ),
      selectRow(
        "默认格式",
        "打开导出对话框时预选的格式",
        s.lastExportFormat,
        [
          { value: "md", label: "Markdown (.md)" },
          { value: "html", label: "HTML (.html)" },
          { value: "pdf", label: "PDF (.pdf)" },
          { value: "docx", label: "Word (.docx)" },
          { value: "txt", label: "纯文本 (.txt)" },
        ],
        (v) => update({ lastExportFormat: v }),
      ),
      el(
        "div",
        { class: "field__hint", style: { marginTop: "var(--sp-4)" } },
        "PDF 使用系统自带的 Edge 排版引擎生成，与预览完全一致；Word 导出会保留标题层级、列表、表格与代码块样式。",
      ),
    );
  }

  function aboutSection(): HTMLElement {
    const s = state.stats;
    return el(
      "div",
      null,
      el("h3", { class: "settings__heading" }, "笔记库统计"),
      el(
        "div",
        { class: "stats-grid" },
        statCard("笔记", String(s.notes)),
        statCard("字数", s.words.toLocaleString("zh-CN")),
        statCard("文件夹", String(s.folders)),
        statCard("标签", String(s.tags)),
        statCard("回收站", String(s.trash)),
        statCard("占用", fileSize(s.bytes)),
      ),
      el(
        "div",
        { class: "setting-row", style: { marginTop: "var(--sp-5)" } },
        el(
          "div",
          { class: "setting-row__text" },
          el("div", { class: "setting-row__title" }, `巧记 ${state.version}`),
          el("div", { class: "setting-row__desc" }, "轻量 · 高效 · 专注"),
        ),
        el(
          "div",
          { class: "setting-row__control setting-row__control--auto" },
          el("button", { class: "btn", type: "button", onclick: deps.openAbout }, "关于"),
        ),
      ),
    );
  }

  function statCard(label: string, value: string): HTMLElement {
    return el(
      "div",
      { class: "stat-card" },
      el("div", { class: "stat-card__value" }, value),
      el("div", { class: "stat-card__label" }, label),
    );
  }

  function paintPanel(): void {
    const builders: Record<SectionId, () => HTMLElement> = {
      general: generalSection,
      editor: editorSection,
      appearance: appearanceSection,
      shortcuts: shortcutsSection,
      export: exportSection,
      about: aboutSection,
    };
    panel.replaceChildren(builders[current]());
    panel.scrollTop = 0;
  }

  paintNav();
  paintPanel();

  const unsubscribe = subscribe(["settings", "stats"], () => {
    // Only the read-only summaries need refreshing; rebuilding while a slider
    // is being dragged would fight the user's input.
    if (current === "about") paintPanel();
  });

  openModal({
    title: "设置",
    width: 720,
    variant: "settings-modal",
    body: el("div", { class: "settings__grid" }, nav, panel),
    onClose: unsubscribe,
  });
}

/* ---------------------------------------------------------------- shortcuts */

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: "文件",
    items: [
      ["新建笔记", "Ctrl + N"],
      ["打开笔记", "Ctrl + O"],
      ["保存", "Ctrl + S"],
      ["导出", "Ctrl + E"],
      ["关闭标签", "Ctrl + W"],
    ],
  },
  {
    group: "编辑",
    items: [
      ["撤销", "Ctrl + Z"],
      ["重做", "Ctrl + Y"],
      ["查找", "Ctrl + F"],
      ["替换", "Ctrl + H"],
      ["加粗", "Ctrl + B"],
      ["斜体", "Ctrl + I"],
      ["行内代码", "Ctrl + E"],
      ["插入链接", "Ctrl + K"],
      ["任务项", "Ctrl + Shift + L"],
      ["一到四级标题", "Ctrl + 1 ~ 4"],
    ],
  },
  {
    group: "视图",
    items: [
      ["预览切换", "Ctrl + P"],
      ["命令面板", "Ctrl + Shift + P"],
      ["全文搜索", "Ctrl + Shift + F"],
      ["侧边栏", "Ctrl + \\"],
      ["下一个标签", "Ctrl + Tab"],
      ["设置", "Ctrl + ,"],
      ["快捷键", "Ctrl + /"],
    ],
  },
];

export function openShortcuts(): void {
  openModal({
    title: "快捷键",
    width: 560,
    body: el(
      "div",
      { class: "shortcuts" },
      ...SHORTCUTS.map((section) =>
        el(
          "div",
          { class: "shortcuts__group" },
          el("h3", { class: "settings__heading" }, section.group),
          ...section.items.map(([label, combo]) =>
            el(
              "div",
              { class: "shortcuts__row" },
              el("span", { class: "truncate" }, label),
              el(
                "span",
                { class: "kbd" },
                ...combo.split(" + ").map((key) => el("span", null, key)),
              ),
            ),
          ),
        ),
      ),
    ),
  });
}

/* ---------------------------------------------------------------- about */

export function openAbout(): void {
  openModal({
    width: 380,
    showCloseButton: true,
    body: el(
      "div",
      { class: "about" },
      brandMark("about__mark"),
      el("div", { class: "about__name" }, "巧记"),
      el("div", { class: "about__version" }, `版本 ${state.version}`),
      el("div", { class: "about__tagline" }, "轻量 · 高效 · 专注"),
      el("div", { class: "about__divider" }),
      el(
        "div",
        { class: "about__meta" },
        el("div", null, `本地笔记 ${state.stats.notes} 篇 · ${fileSize(state.stats.bytes)}`),
        el("div", null, "所有笔记都是本地 Markdown 文件"),
      ),
      el("div", { class: "about__copyright" }, "© 2026 巧记"),
    ),
  });
}
