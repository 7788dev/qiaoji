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
	name = sanitise(name)

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
	if s == "" || isReservedWindowsName(s) {
		s = "未命名笔记"
	}
	return s
}

func isReservedWindowsName(name string) bool {
	base := strings.TrimRight(strings.TrimSpace(name), ".")
	if dot := strings.IndexByte(base, '.'); dot >= 0 {
		base = base[:dot]
	}
	switch strings.ToLower(base) {
	case "con", "prn", "aux", "nul", "clock$", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9":
		return true
	default:
		return false
	}
}

// Run writes the file and returns its absolute path.
func Run(r Request) (string, error) {
	out, err := r.target()
	if err != nil {
		return "", err
	}

	tmp, err := os.CreateTemp(filepath.Dir(out), ".qiaoji-export-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return "", err
	}
	_ = os.Remove(tmpName)
	cleanup := func() { _ = os.Remove(tmpName) }
	writeErr := func(err error) (string, error) {
		cleanup()
		return "", err
	}

	switch r.Format {
	case FormatMarkdown:
		if err := os.WriteFile(tmpName, []byte(normaliseEOL(r.Markdown)), 0o644); err != nil {
			return writeErr(err)
		}

	case FormatText:
		if err := os.WriteFile(tmpName, []byte(normaliseEOL(toPlainText(r.Markdown))), 0o644); err != nil {
			return writeErr(err)
		}

	case FormatHTML:
		doc, err := standaloneHTML(r)
		if err != nil {
			return writeErr(err)
		}
		if err := os.WriteFile(tmpName, []byte(doc), 0o644); err != nil {
			return writeErr(err)
		}

	case FormatPDF:
		if err := writePDF(r, tmpName); err != nil {
			return writeErr(err)
		}

	case FormatDOCX:
		if err := writeDOCX(r, tmpName); err != nil {
			return writeErr(err)
		}

	default:
		return writeErr(fmt.Errorf("不支持的导出格式: %s", r.Format))
	}
	if err := replaceExportFile(tmpName, out); err != nil {
		return writeErr(err)
	}
	cleanup()
	return out, nil
}

func replaceExportFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeExportBytes(dst, data)
}

func writeExportBytes(dst string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".qiaoji-export-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o644); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, dst); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}

// normaliseEOL gives exported text files Windows line endings so Notepad and
// Word do not show one run-on line.
func normaliseEOL(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.ReplaceAll(s, "\n", "\r\n")
}
