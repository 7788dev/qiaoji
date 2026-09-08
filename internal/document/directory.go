package document

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"qiaoji/internal/store"
)

type Entry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
}

type DirectoryPage struct {
	Entries    []Entry `json:"entries"`
	NextCursor string  `json:"nextCursor"`
}

// ListDirectory only inspects one directory. It neither recursively loads
// document bodies nor creates marker/cache files inside the selected folder.
func ListDirectory(root, path, cursor string) (DirectoryPage, error) {
	result := DirectoryPage{Entries: []Entry{}}
	if path == "" {
		path = root
	}
	root, err := store.AbsolutePath(root)
	if err != nil {
		return result, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return result, err
	}
	path, err = store.AbsolutePath(path)
	if err != nil {
		return result, err
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return result, err
	}
	rel, err := filepath.Rel(root, canonical)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || PathKey(canonical) != PathKey(path) {
		return result, errors.New("文件夹不在当前目录内")
	}
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.EqualFold(part, ".qiaoji") {
			return result, errors.New("内部目录不可浏览")
		}
	}
	items, err := os.ReadDir(canonical)
	if err != nil {
		return result, err
	}
	for _, item := range items {
		if item.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := item.Name()
		if item.IsDir() {
			switch strings.ToLower(name) {
			case ".qiaoji", ".git", "node_modules", ".idea", ".vscode":
				continue
			}
		} else {
			ext := strings.ToLower(filepath.Ext(name))
			if ext != ".md" && ext != ".markdown" {
				continue
			}
		}
		result.Entries = append(result.Entries, Entry{Name: name, Path: filepath.Join(canonical, name), Directory: item.IsDir()})
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Directory != b.Directory {
			return a.Directory
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	offset := 0
	if cursor != "" {
		offset, err = strconv.Atoi(cursor)
		if err != nil || offset < 0 {
			return DirectoryPage{}, errors.New("无效的分页位置")
		}
	}
	if offset >= len(result.Entries) {
		result.Entries = []Entry{}
		return result, nil
	}
	end := offset + 200
	if end < len(result.Entries) {
		result.NextCursor = strconv.Itoa(end)
	} else {
		end = len(result.Entries)
	}
	result.Entries = result.Entries[offset:end]
	return result, nil
}
