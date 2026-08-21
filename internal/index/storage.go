package index

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

var indexSidecars = []string{"", "-wal", "-shm"}

// Discard removes one disposable index and its SQLite sidecars.
func Discard(path string) error {
	for _, suffix := range indexSidecars {
		if err := os.Remove(path + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// PrepareExternal copies a legacy vault-local database into AppData, validates
// the copy, then removes only the three index files owned by Qiaoji. Markdown,
// attachments, trash and the vault marker are never migration targets.
func PrepareExternal(legacyPath, targetPath string) (bool, error) {
	if _, err := os.Stat(targetPath); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if _, err := os.Stat(legacyPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return false, err
	}
	copied := make([]string, 0, len(indexSidecars))
	cleanupTarget := func() {
		for _, path := range copied {
			_ = os.Remove(path)
		}
	}
	for _, suffix := range indexSidecars {
		source := legacyPath + suffix
		if _, err := os.Stat(source); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			cleanupTarget()
			return false, err
		}
		target := targetPath + suffix
		if err := copyAtomic(source, target); err != nil {
			cleanupTarget()
			return false, fmt.Errorf("copy legacy index: %w", err)
		}
		copied = append(copied, target)
	}
	ix, err := Open(targetPath)
	if err == nil {
		err = ix.IntegrityCheck()
		_ = ix.Close()
	}
	if err != nil {
		cleanupTarget()
		return false, fmt.Errorf("validate migrated index: %w", err)
	}
	if err := CleanupLegacy(legacyPath); err != nil {
		return true, err
	}
	return true, nil
}

// CleanupLegacy removes only known Qiaoji index files after an external cache
// has been opened successfully.
func CleanupLegacy(legacyPath string) error {
	for _, suffix := range indexSidecars {
		if err := os.Remove(legacyPath + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func copyAtomic(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(target), ".index-migrate-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if _, err := io.Copy(tmp, in); err != nil {
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
	if err := os.Rename(tmpName, target); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}
