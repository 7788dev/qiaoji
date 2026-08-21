package index

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"qiaoji/internal/store"
	"qiaoji/internal/watch"
)

// Delta is the exact set of index rows affected by one serial sync pass.
// Updated rows carry complete list metadata so the frontend can patch a row
// without querying the entire page again.
type Delta struct {
	Upserted    []store.Meta `json:"upserted,omitempty"`
	Previous    []store.Meta `json:"previous,omitempty"`
	Removed     []string     `json:"removed,omitempty"`
	RemovedMeta []store.Meta `json:"removedMeta,omitempty"`
	Full        bool         `json:"full,omitempty"`
	Count       int          `json:"-"`
}

func (d Delta) Changed() int {
	if d.Count > 0 {
		return d.Count
	}
	return len(d.Upserted) + len(d.Removed)
}

// SyncChanges applies a path-level ChangeSet. A full StatWalk is reserved for
// overflow/unknown events; file changes read one file and directory changes
// scan only the named subtree.
func (ix *Index) SyncChanges(v *store.Vault, cs watch.ChangeSet) (Delta, error) {
	if cs.Overflow || cs.Unknown {
		changed, err := ix.Sync(v)
		return Delta{Full: true, Count: changed}, err
	}

	filePaths := make(map[string]struct{})
	dirPaths := make(map[string]struct{})
	for _, path := range cs.Paths() {
		if path == "" {
			continue
		}
		if isDirectoryPath(path, cs.Dirs) {
			dirPaths[filepath.Clean(path)] = struct{}{}
		} else if isMarkdownPath(path) {
			filePaths[filepath.Clean(path)] = struct{}{}
		}
	}

	delta := Delta{}
	for dir := range dirPaths {
		if err := ix.syncDirectory(v, dir, &delta); err != nil {
			return delta, err
		}
	}
	for path := range filePaths {
		if coveredByDirectory(path, dirPaths) {
			continue
		}
		if err := ix.syncFile(v, path, &delta); err != nil {
			return delta, err
		}
	}
	delta.Removed = uniqueStrings(delta.Removed)
	sort.Slice(delta.Upserted, func(i, j int) bool { return delta.Upserted[i].Path < delta.Upserted[j].Path })
	return delta, nil
}

func isDirectoryPath(path string, dirs []string) bool {
	clean := filepath.Clean(path)
	for _, dir := range dirs {
		if filepath.Clean(dir) == clean {
			return true
		}
	}
	if st, err := os.Stat(clean); err == nil {
		return st.IsDir()
	}
	return false
}

func isMarkdownPath(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown", ".mdown":
		return true
	default:
		return false
	}
}

func coveredByDirectory(path string, dirs map[string]struct{}) bool {
	for dir := range dirs {
		rel, err := filepath.Rel(dir, path)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func (ix *Index) syncFile(v *store.Vault, path string, delta *Delta) error {
	previous, previousErr := ix.MetaByPath(path)
	note, err := v.Read(path)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
			if meta, metaErr := ix.MetaByPath(path); metaErr == nil {
				delta.RemovedMeta = append(delta.RemovedMeta, meta)
			}
			if err := ix.Remove(path); err != nil {
				return err
			}
			delta.Removed = append(delta.Removed, path)
			return nil
		}
		return err
	}
	if owner, ownerErr := ix.PathByID(note.ID); ownerErr == nil && owner != note.Path {
		if _, statErr := os.Stat(owner); errors.Is(statErr, os.ErrNotExist) {
			if meta, metaErr := ix.MetaByPath(owner); metaErr == nil {
				delta.RemovedMeta = append(delta.RemovedMeta, meta)
			}
			if err := ix.Remove(owner); err != nil {
				return err
			}
			delta.Removed = append(delta.Removed, owner)
		} else {
			note, err = v.ReassignID(note.Path)
			if err != nil {
				return err
			}
		}
	}
	if err := ix.Upsert(note); err != nil {
		return err
	}
	if previousErr == nil {
		delta.Previous = append(delta.Previous, previous)
	}
	delta.Upserted = append(delta.Upserted, note.Meta)
	return nil
}

func (ix *Index) syncDirectory(v *store.Vault, dir string, delta *Delta) error {
	folder, err := v.RelativeFolder(dir)
	if err != nil {
		return err
	}
	known, err := ix.PathsUnder(folder)
	if err != nil {
		return err
	}
	stats, err := v.StatSubtree(dir)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	folders, err := v.FolderPathsUnder(dir)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	seen := make(map[string]struct{}, len(stats))
	for _, stat := range stats {
		seen[stat.Path] = struct{}{}
		if err := ix.syncFile(v, stat.Path, delta); err != nil {
			return err
		}
	}
	for _, path := range known {
		if _, ok := seen[path]; ok {
			continue
		}
		if meta, metaErr := ix.MetaByPath(path); metaErr == nil {
			delta.RemovedMeta = append(delta.RemovedMeta, meta)
		}
		if err := ix.Remove(path); err != nil {
			return err
		}
		delta.Removed = append(delta.Removed, path)
	}
	// Note deletes adjust ancestor counts and may recreate their folder cache
	// rows. Reconcile the directory list after those deletes, then add back only
	// directories that still exist on disk.
	if err := ix.RemoveFolder(folder); err != nil {
		return err
	}
	for _, path := range folders {
		if err := ix.AddFolder(path); err != nil {
			return err
		}
	}
	return nil
}

func (ix *Index) MetaByPath(path string) (store.Meta, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	row := ix.db.QueryRow(`SELECT id, path, title, folder, tags, created, updated, favorite, excerpt, words, size FROM notes WHERE path = ?`, path)
	var (
		m                store.Meta
		tags             string
		created, updated int64
		favorite         int
	)
	if err := row.Scan(&m.ID, &m.Path, &m.Title, &m.Folder, &tags, &created, &updated, &favorite, &m.Excerpt, &m.Words, &m.Size); err != nil {
		return store.Meta{}, err
	}
	m.Tags = splitTags(tags)
	m.Created = time.UnixMilli(created)
	m.Updated = time.UnixMilli(updated)
	m.Favorite = favorite == 1
	return m, nil
}

// PathsUnder returns cached paths without touching the filesystem.
func (ix *Index) PathsUnder(folder string) ([]string, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	var rows *sql.Rows
	var err error
	if folder == "" {
		rows, err = ix.db.Query(`SELECT path FROM notes`)
	} else {
		rows, err = ix.db.Query(`SELECT path FROM notes WHERE folder = ? OR folder LIKE ? ESCAPE '\'`, folder, escapeLike(folder)+"/%")
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			return nil, err
		}
		out = append(out, path)
	}
	return out, rows.Err()
}

func uniqueStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, value := range in {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}
