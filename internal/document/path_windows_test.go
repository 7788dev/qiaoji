package document

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	"qiaoji/internal/store"
)

func shortTestPath(t *testing.T, path string) string {
	t.Helper()
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	n, err := windows.GetShortPathName(name, &buffer[0], uint32(len(buffer)))
	if err != nil || int(n) >= len(buffer) {
		t.Fatalf("GetShortPathName: %v, length %d", err, n)
	}
	return windows.UTF16ToString(buffer[:n])
}

func TestWindowsShortNamesNavigateAndReadTheSameFiles(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Markdown writing workspace")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	shortRoot := shortTestPath(t, root)
	if strings.EqualFold(shortRoot, root) {
		t.Skip("8.3 aliases are disabled on this test volume")
	}
	path := fixture(t, root, "写作记录.md", "原始内容")
	shortPath := filepath.Join(shortRoot, filepath.Base(path))
	for _, selected := range []string{root, shortRoot} {
		page, err := ListDirectory(selected, shortRoot, "")
		if err != nil || len(page.Entries) != 1 {
			t.Fatalf("list %q through %q: %#v, %v", selected, shortRoot, page, err)
		}
		vault, err := store.OpenFolder(selected)
		if err != nil {
			t.Fatal(err)
		}
		viaAlias, err := vault.Read(shortPath)
		if err != nil {
			t.Fatal(err)
		}
		viaLong, err := vault.Read(path)
		if err != nil || viaAlias.ID != viaLong.ID || viaAlias.Content != "原始内容" {
			t.Fatalf("short path changed file identity or content: %v", err)
		}
	}
	missing, err := store.AbsolutePath(filepath.Join(shortRoot, "new folder", "草稿.md"))
	if err != nil || !strings.EqualFold(missing, filepath.Join(root, "new folder", "草稿.md")) {
		t.Fatalf("missing destination: %q, %v", missing, err)
	}
	if _, err := ListDirectory(root, filepath.Dir(shortRoot), ""); err == nil {
		t.Fatal("short-name normalization allowed traversal outside the folder")
	}

	internal := filepath.Join(root, store.InternalDir)
	if err := os.Mkdir(internal, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture(t, internal, "private.md", "internal content")
	shortInternal := shortTestPath(t, internal)
	if _, err := ListDirectory(root, shortInternal, ""); err == nil {
		t.Fatal("short-name alias exposed an internal directory")
	}
	vault, err := store.OpenFolder(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vault.Read(filepath.Join(shortInternal, "private.md")); err == nil {
		t.Fatal("short-name alias exposed an internal file")
	}
}
