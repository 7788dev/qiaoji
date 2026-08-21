package main

import (
	"os"
	"testing"

	"qiaoji/internal/store"
)

func TestDiagnosticsSizeSeparatesVaultAndIndex(t *testing.T) {
	vault, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := vault.Create("", "Example", "1234567"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vault.InternalPath("index.db"), []byte("index"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vault.InternalPath("index.db-wal"), []byte("wal"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(vault.InternalPath("ignored.bin"), []byte("not vault data"), 0o644); err != nil {
		t.Fatal(err)
	}

	vaultBytes, indexBytes := diagnosticsSize(vault, vault.InternalPath("index.db"))
	if indexBytes != int64(len("index")+len("wal")) {
		t.Fatalf("index bytes = %d", indexBytes)
	}
	if vaultBytes <= 0 {
		t.Fatal("vault bytes should include the note")
	}
	if vaultBytes >= walkSize(vault.Root(), nil) {
		t.Fatal("vault bytes should exclude the internal .qiaoji directory")
	}
}
