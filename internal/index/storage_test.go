package index

import (
	"os"
	"path/filepath"
	"testing"

	"qiaoji/internal/store"
)

func TestPrepareExternalMigratesOnlyIndexFiles(t *testing.T) {
	root := t.TempDir()
	v, err := store.Open(filepath.Join(root, "vault"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.Create("", "迁移", ""); err != nil {
		t.Fatal(err)
	}
	legacy := v.InternalPath("index.db")
	ix, err := Open(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ix.Sync(v); err != nil {
		t.Fatal(err)
	}
	if err := ix.Close(); err != nil {
		t.Fatal(err)
	}
	ownedOther := v.InternalPath("keep.txt")
	if err := os.WriteFile(ownedOther, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "appdata", "indexes", "id", "index.db")
	migrated, err := PrepareExternal(legacy, target)
	if err != nil || !migrated {
		t.Fatalf("PrepareExternal = %v, %v", migrated, err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy index still exists: %v", err)
	}
	if _, err := os.Stat(ownedOther); err != nil {
		t.Fatalf("unrelated internal file was removed: %v", err)
	}
	moved, err := Open(target)
	if err != nil {
		t.Fatal(err)
	}
	defer moved.Close()
	if count, _ := moved.Count(); count != 1 {
		t.Fatalf("migrated count = %d, want 1", count)
	}
}
