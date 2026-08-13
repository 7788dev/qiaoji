package exporter

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFindBrowserEmptyCandidates(t *testing.T) {
	orig := browserCandidateFn
	browserCandidateFn = func() []string { return nil }
	resetBrowserLookup()
	defer func() {
		browserCandidateFn = orig
		resetBrowserLookup()
	}()

	_, err := findBrowser()
	if !errors.Is(err, errNoBrowser) {
		t.Fatalf("got %v, want errNoBrowser", err)
	}
}

func TestWritePDFUsesInAppEngineFirst(t *testing.T) {
	dir := t.TempDir()
	origPDF := htmlToPDF
	origFind := findBrowserFn
	htmlToPDF = func(_, dst string) error {
		return os.WriteFile(dst, []byte("%PDF-1.4\n%qiaoji-stub\n"), 0o644)
	}
	findBrowserFn = func() (string, error) {
		t.Fatal("browser fallback must not run when the in-app engine succeeds")
		return "", errNoBrowser
	}
	defer func() {
		htmlToPDF = origPDF
		findBrowserFn = origFind
	}()

	path, err := Run(Request{
		Format:   FormatPDF,
		Title:    "应用内引擎",
		Dir:      dir,
		BodyHTML: "<p>正文</p>",
	})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(data), "%PDF") {
		t.Fatalf("not a PDF: %q", data)
	}
}

func TestWritePDFMissingEnginePointsToHTML(t *testing.T) {
	dir := t.TempDir()
	origPDF := htmlToPDF
	origFind := findBrowserFn
	htmlToPDF = func(_, _ string) error {
		return errors.New("webview unavailable")
	}
	findBrowserFn = func() (string, error) {
		return "", errNoBrowser
	}
	defer func() {
		htmlToPDF = origPDF
		findBrowserFn = origFind
	}()

	_, err := Run(Request{
		Format:   FormatPDF,
		Title:    "无引擎",
		Dir:      dir,
		BodyHTML: "<p>正文</p>",
	})
	if err == nil {
		t.Fatal("expected an error when both PDF engines are missing")
	}
	msg := err.Error()
	if !strings.Contains(msg, "HTML") {
		t.Errorf("error should tell the user to export HTML, got %q", msg)
	}
	if strings.Contains(msg, "安装 Edge") {
		t.Errorf("should not tell the user to install Edge: %q", msg)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "*.pdf"))
	if len(matches) != 0 {
		t.Errorf("a failed export should not leave a PDF: %v", matches)
	}
}
