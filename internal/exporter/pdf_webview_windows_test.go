//go:build windows

package exporter

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestWebView2PrintsNonEmptyPDF(t *testing.T) {
	if testing.Short() {
		t.Skip("WebView2 print needs a UI session")
	}
	if os.Getenv("CI") != "" {
		t.Skip("no interactive desktop on CI")
	}

	dir := t.TempDir()
	src := filepath.Join(dir, "note.html")
	html := `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>导出测试</title>
<style>body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;padding:24px}</style>
</head><body>
<h1>导出测试</h1>
<p>行内公式 E = mc²，中文断行。</p>
<p class="katex">∫ e<sup>−x²</sup> dx</p>
</body></html>`
	if err := os.WriteFile(src, []byte(html), 0o644); err != nil {
		t.Fatal(err)
	}

	dst := filepath.Join(dir, "note.pdf")
	if err := printHTMLToPDFWebView2(src, dst); err != nil {
		t.Fatalf("WebView2 PrintToPdf: %v", err)
	}
	assertPDF(t, dst)

	out, err := Run(Request{
		Format:   FormatPDF,
		Title:    "公式笔记",
		Dir:      dir,
		BodyHTML: `<h1>公式笔记</h1><p>行内 <span class="katex">E=mc^2</span></p>`,
		HasMath:  true,
	})
	if err != nil {
		t.Fatalf("Run PDF: %v", err)
	}
	assertPDF(t, out)
}

func assertPDF(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte("%PDF")) {
		t.Fatalf("output is not a PDF (%d bytes)", len(data))
	}
	if len(data) < 200 {
		t.Fatalf("PDF is too small: %d bytes", len(data))
	}
}
