package store

import (
	"io/fs"
	"path/filepath"
	"time"
)

// FileStat is the cheap half of a scan: enough to decide whether a note needs
// re-reading, without touching its contents.
type FileStat struct {
	Path    string
	Size    int64
	ModTime time.Time
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
