package store

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveAssetWritesDetectedImageSafely(t *testing.T) {
	root := t.TempDir()
	vault, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	note, err := vault.Create("notes", "Example", "")
	if err != nil {
		t.Fatal(err)
	}

	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	relative, err := vault.SaveAsset(note.Path, "../Screen Shot.exe", png)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(relative, "assets/") || filepath.Ext(relative) != ".png" {
		t.Fatalf("SaveAsset returned %q", relative)
	}

	resolved, err := vault.ResolveAsset(note.Path, relative)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(resolved)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, png) {
		t.Fatalf("saved bytes = %x, want %x", got, png)
	}

	folders, err := vault.Folders()
	if err != nil {
		t.Fatal(err)
	}
	for _, folder := range folders {
		if folder.Path == "notes/assets" {
			t.Fatal("image-only assets directory should not appear as a note folder")
		}
	}
}

func TestSaveAssetRejectsNonImagesAndOversizeData(t *testing.T) {
	vault, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	note, err := vault.Create("", "Example", "")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := vault.SaveAsset(note.Path, "script.png", []byte("<script>alert(1)</script>")); err == nil {
		t.Fatal("SaveAsset accepted non-image bytes")
	}
	if _, err := vault.SaveAsset(note.Path, "large.png", make([]byte, maxAssetSize+1)); err == nil {
		t.Fatal("SaveAsset accepted an oversized image")
	}
}

func TestResolveAssetRejectsTraversalAndWrongDirectories(t *testing.T) {
	vault, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	note, err := vault.Create("notes", "Example", "")
	if err != nil {
		t.Fatal(err)
	}

	for _, relative := range []string{
		"",
		"../secret.png",
		"assets/../../secret.png",
		"other/image.png",
		"/assets/image.png",
		"assets\\..\\secret.png",
	} {
		if _, err := vault.ResolveAsset(note.Path, relative); err == nil {
			t.Errorf("ResolveAsset accepted %q", relative)
		}
	}
}

func TestResolveAssetRejectsSymlinksOutsideVault(t *testing.T) {
	root := t.TempDir()
	vault, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	note, err := vault.Create("notes", "Example", "")
	if err != nil {
		t.Fatal(err)
	}
	assets := filepath.Join(filepath.Dir(note.Path), "assets")
	if err := os.MkdirAll(assets, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(assets, "outside.png")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, err := vault.ResolveAsset(note.Path, "assets/outside.png"); err == nil {
		t.Fatal("ResolveAsset followed a symlink outside the vault")
	}
}
