/**
 * Snippets and document templates for the editor's insert menu.
 *
 * A snippet body may contain two placeholders:
 *   $SEL  the current selection, so wrapping snippets keep the selected text
 *   $0    where the caret should land afterwards
 *
 * Block snippets declare `block: true`; they are pushed onto their own line so
 * inserting a table halfway through a sentence still produces valid Markdown.
 */

export interface Snippet {
  label: string;
  icon?: string;
  body: string;
  block?: boolean;
  /** Computed at insertion time, for things like the current date. */
  dynamic?: () => string;
}

export type SnippetGroup = {
  label: string;
  icon: string;
  items: Snippet[];
};

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function now(): string {
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function todayWithWeekday(): string {
  return `${today()}（周${WEEKDAYS[new Date().getDay()]}）`;
}

/* ---------------------------------------------------------------- basics */

const basics: Snippet[] = [
  { label: "一级标题", icon: "heading", body: "# $0", block: true },
  { label: "二级标题", icon: "heading", body: "## $0", block: true },
  { label: "三级标题", icon: "heading", body: "### $0", block: true },
  { label: "无序列表", icon: "bulletList", body: "- $0", block: true },
  { label: "有序列表", icon: "list", body: "1. $0", block: true },
  { label: "任务清单", icon: "checkSquare", body: "- [ ] $0", block: true },
  { label: "引用", icon: "quote", body: "> $0", block: true },
  { label: "分割线", icon: "minus", body: "---\n\n$0", block: true },
];

const richer: Snippet[] = [
  {
    label: "代码块",
    icon: "codeTag",
    body: "```$0\n\n```",
    block: true,
  },
  {
    label: "表格",
    icon: "table",
    body:
      "| $0 | 列 2 | 列 3 |\n" +
      "| --- | --- | --- |\n" +
      "|  |  |  |\n" +
      "|  |  |  |",
    block: true,
  },
  { label: "链接", icon: "external", body: "[$SEL]($0)" },
  { label: "图片", icon: "image", body: "![$SEL]($0)" },
  { label: "行内公式", icon: "math", body: "$$SEL$0$" },
  { label: "块级公式", icon: "math", body: "$$\n$0\n$$", block: true },
];

const stamps: Snippet[] = [
  { label: "日期", icon: "clock", body: "$0", dynamic: today },
  { label: "日期与时间", icon: "clock", body: "$0", dynamic: now },
  {
    label: "日期标题",
    icon: "heading",
    body: "$0",
    block: true,
    dynamic: () => `## ${todayWithWeekday()}\n\n`,
  },
];

/* ---------------------------------------------------------------- templates */

/** Whole-document scaffolds, the thing the insert menu is really for. */
const documents: Snippet[] = [
  {
    label: "会议纪要",
    icon: "notes",
    block: true,
    body: "",
    dynamic: () =>
      `# 会议纪要 ${todayWithWeekday()}\n\n` +
      `**参会人**：$0\n\n` +
      `**主题**：\n\n` +
      `## 议题\n\n1. \n2. \n\n` +
      `## 结论\n\n- \n\n` +
      `## 待办\n\n- [ ] 负责人 / 截止时间\n- [ ] \n`,
  },
  {
    label: "日报",
    icon: "clock",
    block: true,
    body: "",
    dynamic: () =>
      `# 日报 ${todayWithWeekday()}\n\n` +
      `## 今日完成\n\n- [x] $0\n\n` +
      `## 明日计划\n\n- [ ] \n\n` +
      `## 阻塞与风险\n\n- \n`,
  },
  {
    label: "周报",
    icon: "clock",
    block: true,
    body: "",
    dynamic: () =>
      `# 周报 ${today()}\n\n` +
      `## 本周完成\n\n- [x] $0\n\n` +
      `## 下周安排\n\n- [ ] \n\n` +
      `## 数据 / 指标\n\n| 指标 | 本周 | 上周 |\n| --- | --- | --- |\n|  |  |  |\n\n` +
      `## 风险\n\n> \n`,
  },
  {
    label: "待办清单",
    icon: "checkSquare",
    block: true,
    body: "",
    dynamic: () =>
      `# 待办 ${today()}\n\n` +
      `## 今天必须做\n\n- [ ] $0\n\n` +
      `## 可以推迟\n\n- [ ] \n\n` +
      `## 已完成\n\n- [x] \n`,
  },
  {
    label: "读书笔记",
    icon: "note",
    block: true,
    body: "",
    dynamic: () =>
      `# 《$0》读书笔记\n\n` +
      `**作者**：\n**读完时间**：${today()}\n\n` +
      `## 核心观点\n\n- \n\n` +
      `## 摘录\n\n> \n\n` +
      `## 我的思考\n\n\n`,
  },
  {
    label: "技术方案",
    icon: "layout",
    block: true,
    body: "",
    dynamic: () =>
      `# $0 技术方案\n\n` +
      `## 背景\n\n\n\n` +
      `## 目标\n\n- \n\n` +
      `## 方案\n\n### 方案一\n\n**优点**：\n\n**缺点**：\n\n` +
      `## 选型结论\n\n\n\n` +
      `## 风险与回滚\n\n- \n`,
  },
];

export const snippetGroups: SnippetGroup[] = [
  { label: "基础", icon: "heading", items: basics },
  { label: "内容块", icon: "table", items: richer },
  { label: "时间", icon: "clock", items: stamps },
];

export const documentTemplates: SnippetGroup = {
  label: "模板",
  icon: "copy",
  items: documents,
};

/** Resolves a snippet's text, running its dynamic part if it has one. */
export function snippetBody(snippet: Snippet): string {
  return snippet.dynamic ? snippet.dynamic() : snippet.body;
}
