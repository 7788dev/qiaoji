package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestConcurrentSaveAlwaysProducesValidJSON(t *testing.T) {
	t.Parallel()

	settingsPath := filepath.Join(t.TempDir(), "settings.json")
	st := &Store{path: settingsPath, s: Defaults()}

	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := st.Patch(func(s *Settings) {
				if i%2 == 0 {
					s.Theme = "light"
					s.FontFamily = "a-long-font-family-name-used-to-vary-the-payload-size"
				} else {
					s.Theme = "dark"
					s.FontFamily = "system"
				}
				s.Zoom = 50 + i%151
			}); err != nil {
				t.Errorf("Patch() error = %v", err)
			}
		}()
	}
	wg.Wait()

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	var got Settings
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("settings.json is invalid after concurrent saves: %v\n%s", err, data)
	}

	matches, err := filepath.Glob(filepath.Join(filepath.Dir(settingsPath), ".settings-*.tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 0 {
		t.Fatalf("temporary settings files were not cleaned up: %v", matches)
	}
}

func TestLoadBacksUpCorruptSettings(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	settingsPath := filepath.Join(dir, "settings.json")
	const corrupt = `{"vaultPath":`
	if err := os.WriteFile(settingsPath, []byte(corrupt), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := load(settingsPath)
	if err == nil {
		t.Fatal("load() error = nil, want corrupt-settings error")
	}
	if st.Get().VaultPath != Defaults().VaultPath {
		t.Fatalf("load() did not return usable defaults")
	}
	if _, statErr := os.Stat(settingsPath); !os.IsNotExist(statErr) {
		t.Fatalf("corrupt source still exists: %v", statErr)
	}
	backups, globErr := filepath.Glob(settingsPath + ".corrupt-*")
	if globErr != nil {
		t.Fatal(globErr)
	}
	if len(backups) != 1 {
		t.Fatalf("corrupt backup count = %d, want 1", len(backups))
	}
	data, readErr := os.ReadFile(backups[0])
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != corrupt {
		t.Fatalf("backup = %q, want %q", data, corrupt)
	}
}

func TestLoadOldSettingsAddsPersistedPanelWidths(t *testing.T) {
	t.Parallel()

	settingsPath := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"vaultPath":"C:\\notes","theme":"dark"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := load(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	got := st.Get()
	if got.SidebarWidth != 208 || got.ListWidth != 292 {
		t.Fatalf("panel widths = %d/%d, want 208/292", got.SidebarWidth, got.ListWidth)
	}
	if got.Theme != "dark" || got.VaultPath != `C:\notes` {
		t.Fatalf("old settings were not preserved: %+v", got)
	}
}

func TestPanelWidthsAreNormalised(t *testing.T) {
	t.Parallel()

	settings := Defaults()
	settings.SidebarWidth = 10
	settings.ListWidth = 900
	settings.normalise()
	if settings.SidebarWidth != Defaults().SidebarWidth || settings.ListWidth != Defaults().ListWidth {
		t.Fatalf("normalised widths = %d/%d", settings.SidebarWidth, settings.ListWidth)
	}
}

func TestLegacyExtensionSettingsAreDroppedOnSave(t *testing.T) {
	t.Parallel()

	settingsPath := filepath.Join(t.TempDir(), "settings.json")
	legacy := `{
  "vaultPath": "C:\\notes",
  "theme": "dark",
  "hexoProjects": [{"id": "old-project", "path": "C:\\blog"}],
  "lastHexoProjectId": "old-project",
  "managedNodeRuntime": {"version": "22.0.0"}
}`
	if err := os.WriteFile(settingsPath, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	st, err := load(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if got := st.Get(); got.Theme != "dark" || got.VaultPath != `C:\notes` {
		t.Fatalf("ordinary settings were not preserved: %+v", got)
	}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, removed := range []string{"hexoProjects", "lastHexoProjectId", "managedNodeRuntime"} {
		if bytes.Contains(saved, []byte(removed)) {
			t.Errorf("legacy setting %q survived save:\n%s", removed, saved)
		}
	}
}
