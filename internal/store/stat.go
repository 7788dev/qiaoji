package store

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// FileStat is the cheap half of a scan: enough to decide whether a note needs
// re-reading, without touching its contents.
type FileStat struct {
	Path    string
	Size    int64
	ModTime time.Time
}

// StatSubtree lists Markdown files below one path. A file path produces at
// most one row; a directory walks only that directory. Missing paths are an
// empty result, which is exactly what a delete/rename event means.
func (v *Vault) StatSubtree(path string) ([]FileStat, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := filepath.Abs(path)
	if err != nil || !v.contains(abs) {
		return nil, ErrNotFound
	}
	info, err := os.Stat(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []FileStat{}, nil
		}
		return nil, err
	}
	if !info.IsDir() {
		if !isMarkdown(info.Name()) {
			return []FileStat{}, nil
		}
		return []FileStat{{Path: abs, Size: info.Size(), ModTime: info.ModTime()}}, nil
	}
	var out []FileStat
	err = filepath.WalkDir(abs, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if d.IsDir() {
			if p != abs && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !isMarkdown(d.Name()) {
			return nil
		}
		entry, infoErr := d.Info()
		if infoErr == nil {
			out = append(out, FileStat{Path: p, Size: entry.Size(), ModTime: entry.ModTime()})
		}
		return nil
	})
	return out, err
}

// RelativeFolder turns an absolute directory path into the normalized folder
// key stored by the index.
func (v *Vault) RelativeFolder(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil || !v.contains(abs) {
		return "", ErrNotFound
	}
	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return "", err
	}
	if rel == "." {
		return "", nil
	}
	return strings.Trim(filepath.ToSlash(rel), "/"), nil
}

// FolderPathsUnder returns normalized directory keys below one directory. It
// is used only for directory-level watcher events, so its cost is scoped to
// the affected subtree rather than the whole vault.
func (v *Vault) FolderPathsUnder(path string) ([]string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := filepath.Abs(path)
	if err != nil || !v.contains(abs) {
		return nil, ErrNotFound
	}
	if info, err := os.Stat(abs); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []string{}, nil
		}
		return nil, err
	} else if !info.IsDir() {
		return []string{}, nil
	}
	var out []string
	err = filepath.WalkDir(abs, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != abs && skipDir(d.Name()) {
			return fs.SkipDir
		}
		rel, relErr := filepath.Rel(v.root, p)
		if relErr != nil || rel == "." {
			return nil
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	return out, err
}

// StatWalk lists every Markdown file with its size and mtime. On a vault with
// thousands of notes this is roughly two orders of magnitude cheaper than
// reading each file, which is what keeps cold start fast.
func (v *Vault) StatWalk() ([]FileStat, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	var out []FileStat
	err := filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if p == v.root {
				return err
			}
			return nil
		}
		if d.IsDir() {
			if p != v.root && skipDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !isMarkdown(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, FileStat{Path: p, Size: info.Size(), ModTime: info.ModTime()})
		return nil
	})
	return out, err
}
