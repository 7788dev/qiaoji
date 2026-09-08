package main

import (
	"path/filepath"
	"testing"

	"qiaoji/internal/index"
	"qiaoji/internal/store"
)

func TestRenameTagProcessesEveryBatch(t *testing.T) {
	vault, err := store.Open(filepath.Join(t.TempDir(), "vault"))
	if err != nil {
		t.Fatal(err)
	}
	ix, err := index.Open(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ix.Close() })

	want := tagMutationBatchSize + 5
	for i := 0; i < want; i++ {
		note, err := vault.Create("", "批量标签", "# 批量标签\n")
		if err != nil {
			t.Fatal(err)
		}
		note, err = vault.SetTags(note.Path, []string{"旧标签"})
		if err != nil {
			t.Fatal(err)
		}
		if err := ix.Upsert(note); err != nil {
			t.Fatal(err)
		}
	}

	app := &App{
		open:       &vaultSession{vault: vault, index: ix},
		selfWrites: make(map[string]selfWriteMark),
	}
	got, err := app.RenameTag("旧标签", "新标签")
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("RenameTag() changed %d notes, want %d", got, want)
	}
	old, err := ix.List(index.Query{Scope: "tag", Value: "旧标签", Limit: want})
	if err != nil {
		t.Fatal(err)
	}
	if len(old) != 0 {
		t.Fatalf("old tag still matches %d notes", len(old))
	}
	updated, err := ix.List(index.Query{Scope: "tag", Value: "新标签", Limit: want})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated) != want {
		t.Fatalf("new tag matches %d notes, want %d", len(updated), want)
	}
}
