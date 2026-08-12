package store

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const maxAssetSize = 25 << 20

var assetExtensions = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// SaveAsset stores an image beside its note in an assets directory and
// returns the Markdown-relative path. Assets are deliberately retained when a
// single note is deleted: another note may reference the same file, and
// preserving an orphan is safer than deleting user data.
func (v *Vault) SaveAsset(notePath, filename string, data []byte) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if !v.contains(notePath) || !isMarkdown(filepath.Base(notePath)) {
		return "", ErrNotFound
	}
	resolvedNote, ok := resolvedWithin(v.root, notePath)
	if !ok {
		return "", ErrNotFound
	}
	if info, err := os.Stat(resolvedNote); err != nil || info.IsDir() {
		if err != nil {
			return "", err
		}
		return "", ErrNotFound
	}
	if len(data) == 0 {
		return "", errors.New("图片内容为空")
	}
	if len(data) > maxAssetSize {
		return "", fmt.Errorf("图片超过 %d MB 限制", maxAssetSize>>20)
	}

	contentType := http.DetectContentType(data)
	ext, ok := assetExtensions[contentType]
	if !ok {
		return "", errors.New("仅支持 PNG、JPEG、GIF 和 WebP 图片")
	}

	base := filepath.Base(strings.TrimSpace(filename))
	base = strings.TrimSuffix(base, filepath.Ext(base))
	base = slugify(base)
	if base == "" {
		base = "image"
	}

	dir := filepath.Join(filepath.Dir(notePath), "assets")
	if !v.contains(dir) {
		return "", errors.New("附件目录不在笔记库内")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if _, ok := resolvedWithin(v.root, dir); !ok {
		return "", errors.New("附件目录不在笔记库内")
	}
	target := uniqueAssetPath(dir, base, ext)
	if err := writeAtomic(target, data); err != nil {
		return "", err
	}
	return filepath.ToSlash(filepath.Join("assets", filepath.Base(target))), nil
}

// ResolveAsset turns a note-relative image path into a validated absolute
// path for the Wails asset server.
func (v *Vault) ResolveAsset(notePath, relative string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	if !v.contains(notePath) || !isMarkdown(filepath.Base(notePath)) {
		return "", ErrNotFound
	}
	if resolvedNote, ok := resolvedWithin(v.root, notePath); !ok {
		return "", ErrNotFound
	} else if info, err := os.Stat(resolvedNote); err != nil || info.IsDir() {
		return "", ErrNotFound
	}
	if relative == "" || filepath.IsAbs(relative) {
		return "", ErrNotFound
	}

	assetsRoot := filepath.Join(filepath.Dir(notePath), "assets")
	target := filepath.Clean(filepath.Join(filepath.Dir(notePath), filepath.FromSlash(relative)))
	rel, err := filepath.Rel(assetsRoot, target)
	if err != nil || rel == "." || rel == ".." ||
		strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrNotFound
	}
	if !v.contains(target) {
		return "", ErrNotFound
	}
	resolvedAssets, ok := resolvedWithin(v.root, assetsRoot)
	if !ok {
		return "", ErrNotFound
	}
	resolvedTarget, ok := resolvedWithin(resolvedAssets, target)
	if !ok {
		return "", ErrNotFound
	}
	info, err := os.Stat(resolvedTarget)
	if err != nil || info.IsDir() {
		return "", ErrNotFound
	}
	return resolvedTarget, nil
}

func uniqueAssetPath(dir, base, ext string) string {
	candidate := filepath.Join(dir, base+ext)
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s-%d%s", base, i, ext))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
}

// resolvedWithin follows symlinks in both paths and returns the canonical
// target only if it remains under root. This prevents a user-controlled
// assets symlink from turning the local image endpoint into an arbitrary-file
// reader.
func resolvedWithin(root, target string) (string, bool) {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", false
	}
	resolvedTarget, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", false
	}
	rel, err := filepath.Rel(resolvedRoot, resolvedTarget)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return resolvedTarget, true
}
