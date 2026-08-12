// Package export turns a note into the five formats the export dialog offers.
//
// HTML and PDF reuse the HTML the frontend already rendered, so what the user
// sees in preview is exactly what lands in the file. Markdown, plain text and
// DOCX are produced from the Markdown source instead.
package exporter

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Format string

const (
	FormatMarkdown Format = "md"
	FormatHTML     Format = "html"
	FormatPDF      Format = "pdf"
	FormatDOCX     Format = "docx"
	FormatText     Format = "txt"
)

// Request is what the export dialog sends over.
type Request struct {
	Format   Format `json:"format"`
	Title    string `json:"title"`
	FileName string `json:"fileName"`
	Dir      string `json:"dir"`
	Markdown string `json:"markdown"`
	// BodyHTML is the rendered preview markup, supplied for html and pdf.
	BodyHTML string `json:"bodyHtml"`
	// HasMath gates the 360 KB inlined KaTeX stylesheet.
	HasMath bool `json:"hasMath"`
}

var extensions = map[Format]string{
	FormatMarkdown: ".md",
	FormatHTML:     ".html",
	FormatPDF:      ".pdf",
	FormatDOCX:     ".docx",
	FormatText:     ".txt",
}

func (r Request) target() (string, error) {
	ext, ok := extensions[r.Format]
	if !ok {
		return "", fmt.Errorf("不支持的导出格式: %s", r.Format)
	}
	if r.Dir == "" {
		return "", errors.New("请选择保存位置")
	}
	if err := os.MkdirAll(r.Dir, 0o755); err != nil {
		return "", err
	}

	name := strings.TrimSpace(r.FileName)
	if name == "" {
		name = strings.TrimSpace(r.Title)
	}
	if name == "" {
		name = "未命名笔记"
	}
	name = sanitise(name)
	name = strings.TrimSuffix(name, ext)

	p := filepath.Join(r.Dir, name+ext)
	for i := 2; fileExists(p) && i < 1000; i++ {
		p = filepath.Join(r.Dir, fmt.Sprintf("%s (%d)%s", name, i, ext))
	}
	return p, nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func sanitise(name string) string {
	var sb strings.Builder
	for _, r := range name {
		if r < 0x20 || strings.ContainsRune(`<>:"/\|?*`, r) {
			sb.WriteRune('-')
			continue
		}
		sb.WriteRune(r)
	}
	s := strings.Trim(strings.TrimSpace(sb.String()), ". ")
	if r := []rune(s); len(r) > 120 {
		s = string(r[:120])
	}
	if s == "" {
		s = "未命名笔记"
	}
	return s
}

// Run writes the file and returns its absolute path.
func Run(r Request) (string, error) {
	out, err := r.target()
	if err != nil {
		return "", err
	}

	switch r.Format {
	case FormatMarkdown:
		return out, os.WriteFile(out, []byte(normaliseEOL(r.Markdown)), 0o644)

	case FormatText:
		return out, os.WriteFile(out, []byte(normaliseEOL(toPlainText(r.Markdown))), 0o644)

	case FormatHTML:
		doc, err := standaloneHTML(r)
		if err != nil {
			return "", err
		}
		return out, os.WriteFile(out, []byte(doc), 0o644)

	case FormatPDF:
		if err := writePDF(r, out); err != nil {
			return "", err
		}
		return out, nil

	case FormatDOCX:
		if err := writeDOCX(r, out); err != nil {
			return "", err
		}
		return out, nil
	}
	return "", fmt.Errorf("不支持的导出格式: %s", r.Format)
}

// normaliseEOL gives exported text files Windows line endings so Notepad and
// Word do not show one run-on line.
func normaliseEOL(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}
