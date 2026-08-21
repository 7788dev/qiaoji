package index

import (
	"database/sql"
	"sort"
	"strings"

	"qiaoji/internal/store"
)

func ensureFolderRowsTx(tx *sql.Tx, folder string) error {
	folder = strings.Trim(strings.TrimSpace(folder), "/")
	for current := folder; current != ""; current = parentFolder(current) {
		if _, err := tx.Exec(`INSERT OR IGNORE INTO folder_cache(path) VALUES(?)`, current); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT OR IGNORE INTO folder_counts(path, count) VALUES(?, 0)`, current); err != nil {
			return err
		}
	}
	return nil
}

func adjustFolderCountsTx(tx *sql.Tx, folder string, delta int) error {
	folder = strings.Trim(strings.TrimSpace(folder), "/")
	for current := folder; current != ""; current = parentFolder(current) {
		if err := ensureFolderRowsTx(tx, current); err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE folder_counts SET count = MAX(0, count + ?) WHERE path = ?`, delta, current); err != nil {
			return err
		}
	}
	return nil
}

func rebuildFolderCountsTx(tx *sql.Tx) error {
	if _, err := tx.Exec(`DELETE FROM folder_counts`); err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT folder, COUNT(*) FROM notes WHERE folder <> '' GROUP BY folder`)
	if err != nil {
		return err
	}
	type entry struct {
		folder string
		count  int
	}
	var entries []entry
	for rows.Next() {
		var item entry
		if err := rows.Scan(&item.folder, &item.count); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, item)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range entries {
		if err := adjustFolderCountsTx(tx, item.folder, item.count); err != nil {
			return err
		}
	}
	return nil
}

func parentFolder(folder string) string {
	if at := strings.LastIndex(folder, "/"); at >= 0 {
		return folder[:at]
	}
	return ""
}

// ReplaceFolders refreshes the directory cache after an explicit full disk
// calibration. Empty directories remain visible even though they have no note
// row from which to infer their existence.
func (ix *Index) ReplaceFolders(folders []store.Folder) error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM folder_cache`); err != nil {
		return err
	}
	for _, folder := range folders {
		if err := ensureFolderRowsTx(tx, folder.Path); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (ix *Index) AddFolder(folder string) error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := ensureFolderRowsTx(tx, folder); err != nil {
		return err
	}
	return tx.Commit()
}

func (ix *Index) RenameFolder(oldPath, newPath string) error {
	oldPath = strings.Trim(oldPath, "/")
	newPath = strings.Trim(newPath, "/")
	if oldPath == "" || newPath == "" {
		return nil
	}
	ix.mu.Lock()
	defer ix.mu.Unlock()
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT path FROM folder_cache WHERE path = ? OR path LIKE ? ESCAPE '\'`, oldPath, escapeLike(oldPath)+`/%`)
	if err != nil {
		return err
	}
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			rows.Close()
			return err
		}
		paths = append(paths, path)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM folder_cache WHERE path = ? OR path LIKE ? ESCAPE '\'`, oldPath, escapeLike(oldPath)+`/%`); err != nil {
		return err
	}
	for _, path := range paths {
		replaced := newPath + strings.TrimPrefix(path, oldPath)
		if err := ensureFolderRowsTx(tx, replaced); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (ix *Index) RemoveFolder(folder string) error {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	_, err := ix.db.Exec(`DELETE FROM folder_cache WHERE path = ? OR path LIKE ? ESCAPE '\'`, folder, escapeLike(folder)+`/%`)
	return err
}

// Folders returns cached directories with descendant-inclusive note counts.
func (ix *Index) Folders() ([]store.Folder, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	rows, err := ix.db.Query(`SELECT c.path, COALESCE(n.count, 0) FROM folder_cache c LEFT JOIN folder_counts n ON n.path = c.path ORDER BY c.path ASC`)
	if err != nil {
		return nil, err
	}
	type cachedFolder struct {
		path  string
		count int
	}
	var cached []cachedFolder
	for rows.Next() {
		var folder cachedFolder
		if err := rows.Scan(&folder.path, &folder.count); err != nil {
			rows.Close()
			return nil, err
		}
		cached = append(cached, folder)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := make([]store.Folder, 0, len(cached))
	for _, folder := range cached {
		if pathLeaf(folder.path) == "assets" && folder.count == 0 {
			continue
		}
		out = append(out, store.Folder{Name: pathLeaf(folder.path), Path: folder.path, Count: folder.count})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

func pathLeaf(path string) string {
	if at := strings.LastIndex(path, "/"); at >= 0 {
		return path[at+1:]
	}
	return path
}
