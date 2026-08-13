package exporter

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// htmlToPDF, when set, is the preferred renderer. On Windows this is a hidden
// WebView2 PrintToPdf pass, so exporting works even without Edge/Chrome.
var htmlToPDF func(srcHTML, dstPDF string) error

// findBrowserFn locates a Chromium CLI binary. Tests replace it.
var findBrowserFn = findBrowser

var errNoBrowser = errors.New("未找到 Microsoft Edge 或 Chrome")

const pdfUseHTML = "请改用 HTML 导出"

func pdfFailed(detail error) error {
	if detail == nil {
		return errors.New("无法导出 PDF。" + pdfUseHTML)
	}
	return fmt.Errorf("无法导出 PDF: %v。%s", detail, pdfUseHTML)
}

// writePDF renders the standalone HTML through WebView2 when possible, then
// falls back to a headless Edge/Chrome CLI. Both paths use the same engine as
// the preview, so maths, highlighting, tables and CJK breaking match.
func writePDF(r Request, out string) error {
	work, err := os.MkdirTemp("", "qiaoji-pdf-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)

	doc, err := standaloneHTML(r)
	if err != nil {
		return err
	}
	src := filepath.Join(work, "note.html")
	if err := os.WriteFile(src, []byte(doc), 0o644); err != nil {
		return err
	}

	tmpPDF := filepath.Join(work, "note.pdf")

	var wvErr error
	if htmlToPDF != nil {
		wvErr = htmlToPDF(src, tmpPDF)
		if wvErr == nil {
			if st, err := os.Stat(tmpPDF); err == nil && st.Size() > 0 {
				return moveFile(tmpPDF, out)
			}
			wvErr = errors.New("导出的 PDF 为空")
		}
		_ = os.Remove(tmpPDF)
	}

	return writePDFWithBrowser(src, tmpPDF, out, wvErr)
}

func writePDFWithBrowser(src, tmpPDF, out string, wvErr error) error {
	browser, err := findBrowserFn()
	if err != nil {
		if wvErr != nil {
			return pdfFailed(wvErr)
		}
		return pdfFailed(err)
	}

	profile := filepath.Join(filepath.Dir(tmpPDF), "profile")

	// New headless is the default in current Edge, but --print-to-pdf has been
	// more reliable under the old implementation, so that is tried second.
	modes := []string{"--headless=new", "--headless=old"}
	var lastErr error
	for _, mode := range modes {
		lastErr = runBrowser(browser, mode, profile, src, tmpPDF)
		if lastErr == nil {
			if st, err := os.Stat(tmpPDF); err == nil && st.Size() > 0 {
				return moveFile(tmpPDF, out)
			}
			lastErr = errors.New("导出的 PDF 为空")
		}
		_ = os.Remove(tmpPDF)
	}
	if wvErr != nil {
		lastErr = fmt.Errorf("%v; 浏览器: %v", wvErr, lastErr)
	}
	return pdfFailed(lastErr)
}

func runBrowser(browser, mode, profile, src, dst string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	args := []string{
		mode,
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-extensions",
		"--disable-sync",
		"--disable-background-networking",
		"--no-pdf-header-footer",
		"--run-all-compositor-stages-before-draw",
		"--virtual-time-budget=6000",
		"--user-data-dir=" + profile,
		"--print-to-pdf=" + dst,
		fileURL(src),
	}

	cmd := exec.CommandContext(ctx, browser, args...)
	cmd.Dir = filepath.Dir(src)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	hideWindow(cmd)

	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return errors.New("渲染超时")
		}
		// Chromium exits non-zero on harmless GPU warnings; the real signal is
		// whether the file appeared.
		if st, serr := os.Stat(dst); serr == nil && st.Size() > 0 {
			return nil
		}
		msg := strings.TrimSpace(stderr.String())
		if msg != "" {
			return fmt.Errorf("%v: %s", err, lastLine(msg))
		}
		return err
	}
	return nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func fileURL(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	u := filepath.ToSlash(abs)
	if !strings.HasPrefix(u, "/") {
		u = "/" + u
	}
	return "file://" + strings.ReplaceAll(u, " ", "%20")
}

// moveFile falls back to copying when the temp dir is on another volume.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

var (
	browserOnce        sync.Once
	browserPath        string
	browserCandidateFn = defaultBrowserCandidates
)

// findBrowser locates a Chromium binary used only as a fallback when WebView2
// printing is unavailable.
func findBrowser() (string, error) {
	browserOnce.Do(func() {
		for _, c := range browserCandidateFn() {
			if c == "" {
				continue
			}
			if filepath.IsAbs(c) {
				if st, err := os.Stat(c); err == nil && !st.IsDir() {
					browserPath = c
					return
				}
				continue
			}
			if p, err := exec.LookPath(c); err == nil {
				browserPath = p
				return
			}
		}
	})
	if browserPath == "" {
		return "", errNoBrowser
	}
	return browserPath, nil
}

func resetBrowserLookup() {
	browserOnce = sync.Once{}
	browserPath = ""
}

func defaultBrowserCandidates() []string {
	if runtime.GOOS != "windows" {
		return []string{
			"microsoft-edge", "google-chrome", "chromium", "chromium-browser",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		}
	}
	var out []string
	for _, base := range []string{
		os.Getenv("ProgramFiles(x86)"),
		os.Getenv("ProgramFiles"),
		os.Getenv("LocalAppData"),
	} {
		if base == "" {
			continue
		}
		out = append(out,
			filepath.Join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
			filepath.Join(base, "Google", "Chrome", "Application", "chrome.exe"),
		)
	}
	return append(out, "msedge.exe", "chrome.exe")
}
