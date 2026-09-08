package store

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// OpenFolder opens an existing folder without writing application files into it.
// The legacy trash is created lazily, only when a user deletes a document.
func OpenFolder(root string) (*Vault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("请选择文件夹")
	}
	return &Vault{root: filepath.Clean(abs), plainDocuments: true}, nil
}

func plainDocumentID(path string) string {
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	sum := sha256.Sum256([]byte(path))
	return "path-" + hex.EncodeToString(sum[:])
}

// WriteDocument uses the same atomic replacement as the vault, but writes the
// exact Markdown supplied by the document session. It never adds metadata or
// renames a file based on its first heading.
func WriteDocument(path string, data []byte) error {
	return writeAtomic(path, data)
}
