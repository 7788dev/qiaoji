package index

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"qiaoji/internal/store"
)

func TestPlainFolderIndexNeverRewritesDuplicateFrontMatter(t *testing.T) {
	root := t.TempDir()
	raw := "\ufeff---\r\n# keep comment\r\nid: 'duplicate'\r\ncustom: value\r\n---\r\n\r\n中文 search content\r\n"
	stamp := time.Unix(1650000000, 0)
	for _, name := range []string{"甲.md", "乙.md"} {
		path := filepath.Join(root, name)
		if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	v, err := store.OpenFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	ix, err := Open(filepath.Join(t.TempDir(), "search.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ix.Close()
	if _, err = ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	a, err := v.Read(filepath.Join(root, "甲.md"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := v.Read(filepath.Join(root, "乙.md"))
	if err != nil {
		t.Fatal(err)
	}
	if a.ID == b.ID {
		t.Fatal("folder identities must be path based")
	}
	again, _ := v.Read(a.Path)
	if again.ID != a.ID {
		t.Fatal("folder identity changed between reads")
	}
	if _, err = ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"甲.md", "乙.md"} {
		path := filepath.Join(root, name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(path)
		if string(data) != raw || !info.ModTime().Equal(stamp) {
			t.Fatal("indexing rewrote an original file")
		}
	}
	entries, _ := os.ReadDir(root)
	if len(entries) != 2 {
		t.Fatal("opening a plain folder created application files")
	}
}
