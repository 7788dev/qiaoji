package store

import (
	"os"
	"path/filepath"
	"time"
)

type seedNote struct {
	folder  string
	title   string
	tags    []string
	ageMin  int
	favored bool
	body    string
}

// Seed fills a brand new vault so the first launch shows a working app instead
// of an empty shell.
func (v *Vault) Seed() error {
	for _, f := range []string{"工作", "学习", "项目", "日常"} {
		if err := os.MkdirAll(filepath.Join(v.root, f), 0o755); err != nil {
			return err
		}
	}
	for _, s := range seeds {
		n, err := v.Create(s.folder, s.title, s.body)
		if err != nil {
			return err
		}
		created := time.Now().Add(-time.Duration(s.ageMin) * time.Minute)
		_, err = v.UpdateMeta(n.Path, func(fm *frontMatter) {
			fm.Tags = s.tags
			fm.Favorite = s.favored
			fm.Created = created
			fm.Updated = created
		})
		if err != nil {
			return err
		}
		// Front matter carries the timestamps, but the scanner trusts a newer
		// mtime, so align the file clock with the seeded date.
		_ = os.Chtimes(n.Path, created, created)
	}
	return nil
}

var seeds = []seedNote{
	{
		folder: "", title: "欢迎使用巧记",
		tags: []string{"灵感"}, ageMin: 5, favored: true,
		body: "# 欢迎使用巧记\n\n" +
			"这是一款轻量、快速、专注的 Markdown 笔记应用。\n\n" +
			"## 主要特性\n\n" +
			"- 实时预览\n" +
			"- 数学公式渲染\n" +
			"- 多种格式导出\n" +
			"- 极低资源占用\n\n" +
			"## 数学公式示例\n\n" +
			"行内公式：$E = mc^2$\n\n" +
			"块公式：\n\n" +
			"$$\n\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}\n$$\n\n" +
			"$$\n\\int_{-\\infty}^{\\infty} e^{-x^2}\\, dx = \\sqrt{\\pi}\n$$\n\n" +
			"## 上手提示\n\n" +
			"- 按 `Ctrl + Shift + P` 打开命令面板\n" +
			"- 按 `Ctrl + P` 在编辑与预览之间切换\n" +
			"- 按 `Ctrl + N` 新建一篇笔记\n" +
			"- 所有笔记都是本地 `.md` 文件，随时可以用别的编辑器打开\n",
	},
	{
		folder: "", title: "Markdown 语法示例",
		tags: []string{"学习"}, ageMin: 90,
		body: "# Markdown 语法示例\n\n" +
			"## 文本样式\n\n" +
			"**粗体**、*斜体*、~~删除线~~、`行内代码`，以及[链接](https://commonmark.org)。\n\n" +
			"## 列表\n\n" +
			"1. 有序列表第一项\n2. 有序列表第二项\n\n" +
			"- 无序列表\n- 支持嵌套\n  - 第二层\n\n" +
			"## 任务清单\n\n" +
			"- [x] 完成原型还原\n- [ ] 补充导出功能\n- [ ] 性能压测\n\n" +
			"## 引用与分割线\n\n" +
			"> 少即是多，专注内容本身。\n\n---\n\n" +
			"## 代码块\n\n" +
			"```go\nfunc main() {\n\tfmt.Println(\"hello, 巧记\")\n}\n```\n\n" +
			"## 表格\n\n" +
			"| 格式 | 扩展名 | 说明 |\n| --- | --- | --- |\n" +
			"| Markdown | .md | 原样导出 |\n| HTML | .html | 单文件自包含 |\n| PDF | .pdf | 排版与预览一致 |\n",
	},
	{
		folder: "", title: "公式示例",
		tags: []string{"学习", "项目"}, ageMin: 200,
		body: "# 公式示例\n\n" +
			"## 行内\n\n" +
			"质能方程 $E = mc^2$ 与欧拉恒等式 $e^{i\\pi} + 1 = 0$。\n\n" +
			"## 块级\n\n" +
			"高斯定理：\n\n$$\n\\oint_{\\partial V} \\mathbf{E} \\cdot d\\mathbf{A} = \\frac{Q}{\\varepsilon_0}\n$$\n\n" +
			"傅里叶变换：\n\n$$\n\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\, e^{-2\\pi i x \\xi}\\, dx\n$$\n\n" +
			"矩阵：\n\n$$\nA = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$\n",
	},
	{
		folder: "工作", title: "周报计划",
		tags: []string{"工作"}, ageMin: 60 * 26,
		body: "# 周报计划\n\n## 本周完成\n\n- [x] 需求评审\n- [x] 接口联调\n\n" +
			"## 下周安排\n\n- [ ] 性能优化\n- [ ] 灰度发布\n\n## 风险\n\n> 依赖的第三方接口稳定性待观察。\n",
	},
	{
		folder: "学习", title: "读书笔记",
		tags: []string{"学习", "灵感"}, ageMin: 60 * 50,
		body: "# 读书笔记\n\n## 核心观点\n\n把复杂的问题拆成可以独立验证的小块。\n\n" +
			"## 摘录\n\n> 简单是可靠的先决条件。\n\n## 我的思考\n\n" +
			"工具的价值在于减少摩擦，而不是增加选项。\n",
	},
	{
		folder: "日常", title: "灵感记录",
		tags: []string{"灵感", "待办"}, ageMin: 60 * 74,
		body: "# 灵感记录\n\n- 用一个快捷键完成从想法到落笔的全过程\n" +
			"- 深色主题下的公式配色需要单独校准\n- 导出 PDF 时保留代码块的圆角边框\n",
	},
}
