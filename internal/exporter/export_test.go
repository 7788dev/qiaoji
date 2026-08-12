package exporter

import (
	"archive/zip"
	"encoding/xml"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleMarkdown = `# 导出测试

这是一段**加粗**、*斜体*、~~删除线~~和` + "`行内代码`" + `的正文，还有一个[链接](https://example.com)。

## 列表

- 第一项
- 第二项
  - 嵌套项
1. 有序一
2. 有序二

- [x] 已完成
- [ ] 未完成

## 引用

> 少即是多。

## 代码

` + "```go\nfunc main() {\n\tfmt.Println(\"hello\")\n}\n```" + `

## 表格

| 格式 | 扩展名 |
| --- | --- |
| Markdown | .md |
| HTML | .html |

## 公式

行内 $E = mc^2$ 公式。

$$
\int_{-\infty}^{\infty} e^{-x^2}\, dx = \sqrt{\pi}
$$

---

结束。
`

func TestToPlainTextStripsMarkup(t *testing.T) {
	got := toPlainText(sampleMarkdown)

	for _, marker := range []string{"**", "~~", "```", "|---|", "![", "](https://"} {
		if strings.Contains(got, marker) {
			t.Errorf("plain text still contains %q:\n%s", marker, got)
		}
	}
	for _, want := range []string{"导出测试", "加粗", "链接", "少即是多。", "fmt.Println", "☑ 已完成", "☐ 未完成"} {
		if !strings.Contains(got, want) {
			t.Errorf("plain text is missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "[链接]") {
		t.Error("link syntax should collapse to its text")
	}
}

func TestToPlainTextHandlesImages(t *testing.T) {
	got := toPlainText("![风景照](photo.png) 后面的字\n")
	if !strings.Contains(got, "[图片: 风景照]") {
		t.Errorf("got %q", got)
	}
	if !strings.Contains(got, "后面的字") {
		t.Errorf("text after the image was lost: %q", got)
	}
}

func TestStandaloneHTMLIsSelfContained(t *testing.T) {
	r := Request{
		Title:    "导出测试",
		BodyHTML: `<h1>导出测试</h1><p>正文 <span class="katex">x</span></p>`,
		HasMath:  true,
	}
	doc, err := standaloneHTML(r)
	if err != nil {
		t.Fatal(err)
	}

	if !strings.HasPrefix(doc, "<!DOCTYPE html>") {
		t.Error("missing doctype")
	}
	if !strings.Contains(doc, "<title>导出测试</title>") {
		t.Error("missing title")
	}
	if !strings.Contains(doc, r.BodyHTML) {
		t.Error("body markup was not embedded verbatim")
	}
	// No external references: the file has to render with no network and no
	// sidecar assets.
	for _, bad := range []string{"http://", "https://", `url(fonts/`, ".woff2)"} {
		if strings.Contains(doc, bad) {
			t.Errorf("document references something external: %q", bad)
		}
	}
	if !strings.Contains(doc, "data:font/woff2;base64,") {
		t.Error("KaTeX fonts should be inlined when the note has maths")
	}
}

func TestStandaloneHTMLSkipsKatexWithoutMaths(t *testing.T) {
	withMath, _ := standaloneHTML(Request{Title: "a", BodyHTML: "<p>x</p>", HasMath: true})
	without, _ := standaloneHTML(Request{Title: "a", BodyHTML: "<p>x</p>", HasMath: false})

	if strings.Contains(without, "data:font/woff2") {
		t.Error("a note without maths should not carry the KaTeX fonts")
	}
	if len(without) >= len(withMath) {
		t.Errorf("expected a much smaller document without maths: %d vs %d", len(without), len(withMath))
	}
	if len(without) > 40*1024 {
		t.Errorf("plain document is %d bytes; the base stylesheet should stay small", len(without))
	}
}

func TestStandaloneHTMLEscapesTitle(t *testing.T) {
	doc, _ := standaloneHTML(Request{Title: `<script>alert(1)</script>`, BodyHTML: "<p>x</p>"})
	if strings.Contains(doc, "<title><script>") {
		t.Error("the title must be escaped")
	}
}

// ---------------------------------------------------------------- docx

func buildDocx(t *testing.T, md string) string {
	t.Helper()
	out := filepath.Join(t.TempDir(), "out.docx")
	err := writeDOCX(Request{Title: "导出测试", Markdown: md}, out)
	if err != nil {
		t.Fatalf("writeDOCX: %v", err)
	}
	return out
}

func readZipPart(t *testing.T, path, name string) string {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("open docx: %v", err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != name {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		defer rc.Close()
		data, err := io.ReadAll(rc)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	t.Fatalf("part %q not found in %s", name, path)
	return ""
}

func TestDocxHasRequiredParts(t *testing.T) {
	path := buildDocx(t, sampleMarkdown)

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("the docx is not a readable zip: %v", err)
	}
	defer zr.Close()

	present := map[string]bool{}
	for _, f := range zr.File {
		present[f.Name] = true
	}
	required := []string{
		"[Content_Types].xml",
		"_rels/.rels",
		"word/document.xml",
		"word/styles.xml",
		"word/numbering.xml",
		"word/_rels/document.xml.rels",
		"docProps/core.xml",
		"docProps/app.xml",
	}
	for _, name := range required {
		if !present[name] {
			t.Errorf("missing required part %q", name)
		}
	}
}

func TestDocxPartsAreWellFormedXML(t *testing.T) {
	path := buildDocx(t, sampleMarkdown)

	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer zr.Close()

	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, ".xml") && !strings.HasSuffix(f.Name, ".rels") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("%s: %v", f.Name, err)
		}
		dec := xml.NewDecoder(rc)
		for {
			_, err := dec.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Errorf("%s is not well-formed XML: %v", f.Name, err)
				break
			}
		}
		rc.Close()
	}
}

func TestDocxCarriesContent(t *testing.T) {
	path := buildDocx(t, sampleMarkdown)
	doc := readZipPart(t, path, "word/document.xml")

	checks := map[string]string{
		"heading style":  `<w:pStyle w:val="Heading1"/>`,
		"heading text":   `导出测试`,
		"bold run":       `<w:b/>`,
		"italic run":     `<w:i/>`,
		"strikethrough":  `<w:strike/>`,
		"inline code":    `<w:rStyle w:val="CodeChar"/>`,
		"code block":     `<w:pStyle w:val="SourceCode"/>`,
		"code content":   `fmt.Println`,
		"quote style":    `<w:pStyle w:val="Quote"/>`,
		"quote text":     `少即是多。`,
		"list numbering": `<w:numPr>`,
		"table":          `<w:tbl>`,
		"table style":    `<w:tblStyle w:val="TableGrid"/>`,
		"hyperlink":      `<w:hyperlink r:id="`,
		"checked task":   `☑`,
		"unchecked task": `☐`,
		"display maths":  `<w:pStyle w:val="MathBlock"/>`,
		"inline maths":   `<w:rStyle w:val="MathChar"/>`,
		"thematic break": `<w:pBdr>`,
		"section":        `<w:sectPr>`,
	}
	for label, want := range checks {
		if !strings.Contains(doc, want) {
			t.Errorf("document.xml is missing the %s (%q)", label, want)
		}
	}
}

func TestDocxHyperlinkRelationshipsResolve(t *testing.T) {
	path := buildDocx(t, sampleMarkdown)
	doc := readZipPart(t, path, "word/document.xml")
	rels := readZipPart(t, path, "word/_rels/document.xml.rels")

	// Every r:id referenced by the body must exist in the relationship part,
	// otherwise Word reports the file as corrupt.
	for _, chunk := range strings.Split(doc, `<w:hyperlink r:id="`)[1:] {
		id := chunk[:strings.Index(chunk, `"`)]
		if !strings.Contains(rels, `Id="`+id+`"`) {
			t.Errorf("hyperlink %q has no matching relationship", id)
		}
	}
	if !strings.Contains(rels, `Target="https://example.com"`) {
		t.Error("the link target was lost")
	}
	if !strings.Contains(rels, `TargetMode="External"`) {
		t.Error("external links need TargetMode=External")
	}
}

func TestDocxNumberingInstancesMatchLists(t *testing.T) {
	path := buildDocx(t, sampleMarkdown)
	doc := readZipPart(t, path, "word/document.xml")
	numbering := readZipPart(t, path, "word/numbering.xml")

	// Each numId used in the body must be declared in numbering.xml.
	for _, chunk := range strings.Split(doc, `<w:numId w:val="`)[1:] {
		id := chunk[:strings.Index(chunk, `"`)]
		if !strings.Contains(numbering, `<w:num w:numId="`+id+`">`) {
			t.Errorf("numId %q is used but never declared", id)
		}
	}
	if !strings.Contains(numbering, `w:numFmt w:val="bullet"`) {
		t.Error("bullet numbering definition is missing")
	}
	if !strings.Contains(numbering, `w:numFmt w:val="decimal"`) {
		t.Error("decimal numbering definition is missing")
	}
}

// Sibling ordered lists must each restart at 1, which requires a separate
// w:num instance per list.
func TestDocxSeparateListsGetSeparateInstances(t *testing.T) {
	md := "1. 甲\n2. 乙\n\n正文分隔\n\n1. 丙\n2. 丁\n"
	path := buildDocx(t, md)
	doc := readZipPart(t, path, "word/document.xml")

	seen := map[string]bool{}
	for _, chunk := range strings.Split(doc, `<w:numId w:val="`)[1:] {
		seen[chunk[:strings.Index(chunk, `"`)]] = true
	}
	if len(seen) < 2 {
		t.Errorf("got %d numbering instances, want one per list so numbering restarts", len(seen))
	}
}

func TestDocxEscapesDangerousText(t *testing.T) {
	md := "# 标题 <tag> & \"引号\"\n\n正文 <script>alert(1)</script> 和 5 < 6。\n"
	path := buildDocx(t, md)
	doc := readZipPart(t, path, "word/document.xml")

	if strings.Contains(doc, "<script>") {
		t.Error("raw markup leaked into the document XML")
	}
	if !strings.Contains(doc, "&lt;script&gt;") {
		t.Error("the angle brackets should be escaped, not dropped")
	}
	if !strings.Contains(doc, "&amp;") {
		t.Error("ampersands should be escaped")
	}
}

func TestDocxStripsIllegalControlCharacters(t *testing.T) {
	md := "# 标题\n\n正文\x00带\x07控制符\n"
	path := buildDocx(t, md)
	doc := readZipPart(t, path, "word/document.xml")

	if strings.ContainsRune(doc, 0x00) || strings.ContainsRune(doc, 0x07) {
		t.Error("control characters must be stripped; Word refuses to open the file otherwise")
	}
	if !strings.Contains(doc, "带") {
		t.Error("surrounding text should survive")
	}
}

func TestDocxEmptyNoteStillProducesDocument(t *testing.T) {
	path := buildDocx(t, "")
	doc := readZipPart(t, path, "word/document.xml")
	if !strings.Contains(doc, "<w:body>") || !strings.Contains(doc, "<w:sectPr>") {
		t.Error("an empty note should still yield a valid, openable document")
	}
}

// ---------------------------------------------------------------- naming

func TestTargetFileNaming(t *testing.T) {
	dir := t.TempDir()

	r := Request{Format: FormatMarkdown, Title: "我的笔记", Dir: dir}
	first, err := r.target()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(first) != "我的笔记.md" {
		t.Errorf("got %q, want 我的笔记.md", filepath.Base(first))
	}

	// An existing file must not be silently overwritten.
	if err := os.WriteFile(first, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	second, err := r.target()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(second) != "我的笔记 (2).md" {
		t.Errorf("got %q, want 我的笔记 (2).md", filepath.Base(second))
	}
}

func TestTargetSanitisesNames(t *testing.T) {
	dir := t.TempDir()
	r := Request{Format: FormatHTML, FileName: `a/b:c*d?e"f<g>h|i`, Dir: dir}
	got, err := r.target()
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(got)
	for _, ch := range `/\:*?"<>|` {
		if strings.ContainsRune(strings.TrimSuffix(base, ".html"), ch) {
			t.Errorf("filename %q still contains %q", base, ch)
		}
	}
}

func TestTargetRejectsUnknownFormat(t *testing.T) {
	r := Request{Format: "rtf", Title: "x", Dir: t.TempDir()}
	if _, err := r.target(); err == nil {
		t.Error("an unsupported format should be rejected")
	}
}

func TestRunWritesMarkdownAndText(t *testing.T) {
	dir := t.TempDir()

	mdPath, err := Run(Request{Format: FormatMarkdown, Title: "原文", Dir: dir, Markdown: sampleMarkdown})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(mdPath)
	if !strings.Contains(string(data), "**加粗**") {
		t.Error("markdown export should preserve the source verbatim")
	}
	if !strings.Contains(string(data), "\r\n") {
		t.Error("exported text files should use CRLF so Notepad renders them correctly")
	}

	txtPath, err := Run(Request{Format: FormatText, Title: "纯文本", Dir: dir, Markdown: sampleMarkdown})
	if err != nil {
		t.Fatal(err)
	}
	txt, _ := os.ReadFile(txtPath)
	if strings.Contains(string(txt), "**") {
		t.Error("plain text export should strip emphasis markers")
	}
}
