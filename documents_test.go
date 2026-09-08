package main

import (
	"os"
	"path/filepath"
	"testing"

	"qiaoji/internal/config"
	"qiaoji/internal/document"
)

func TestStandaloneTrashRemainsRecoverableAfterRestart(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	dir := t.TempDir()
	path := filepath.Join(dir, "库外笔记.md")
	content := "\ufeff---\r\nid: duplicate\r\ncustom: [原样, 保留]\r\n---\r\n\r\n# 正文\r\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	settings, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	app := &App{settings: settings, documents: document.NewManager()}
	doc, err := app.OpenDocument(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.TrashDocument(doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("trashed document still exists at the original path")
	}
	settings, err = config.Load()
	if err != nil {
		t.Fatal(err)
	}
	restarted := &App{settings: settings, documents: document.NewManager()}
	items, err := restarted.ListDocumentTrash("")
	if err != nil || len(items) != 1 {
		t.Fatalf("standalone trash lost across restart: %#v %v", items, err)
	}
	if _, err := restarted.RestoreDocumentTrash(items[0].Root, items[0].ID); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != content {
		t.Fatal("restoring changed the original Markdown bytes")
	}
}
