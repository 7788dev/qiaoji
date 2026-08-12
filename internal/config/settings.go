// Package config persists user settings outside the vault, so the app can still
// start and show the welcome screen when the vault folder is missing or moved.
package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

const AppName = "巧记"
const AppVersion = "1.0.0"

// WindowState remembers the frame between sessions.
type WindowState struct {
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Maximised bool `json:"maximised"`
}

type Settings struct {
	VaultPath string `json:"vaultPath"`

	// General
	Theme          string `json:"theme"` // light | dark | system
	Language       string `json:"language"`
	Zoom           int    `json:"zoom"` // percent
	Autostart      bool   `json:"autostart"`
	MinimiseToTray bool   `json:"minimiseToTray"`
	CloseToTray    bool   `json:"closeToTray"`
	AutoUpdate     bool   `json:"autoUpdate"`
	// HardwareAcceleration is an escape hatch for machines whose GPU driver
	// makes WebView2 render incorrectly (black panels, torn text). It does not
	// save memory: Chromium keeps a GPU process either way and falls back to
	// software compositing. Read once at startup, so changes need a restart.
	HardwareAcceleration bool `json:"hardwareAcceleration"`

	// Editor
	FontFamily      string  `json:"fontFamily"`
	FontSize        int     `json:"fontSize"`
	LineHeight      float64 `json:"lineHeight"`
	TabSize         int     `json:"tabSize"`
	ShowLineNumbers bool    `json:"showLineNumbers"`
	AutoSave        bool    `json:"autoSave"`
	AutoSaveDelayMs int     `json:"autoSaveDelayMs"`
	AutoPairing     bool    `json:"autoPairing"`

	// Appearance
	EditorWidth  string `json:"editorWidth"` // narrow | medium | wide | full
	ListView     string `json:"listView"`    // list | grid
	SortBy       string `json:"sortBy"`      // updated | created | title
	ShowLivePrev bool   `json:"showLivePreview"`

	// Export
	ExportDir        string `json:"exportDir"`
	LastExportFormat string `json:"lastExportFormat"`

	Window WindowState `json:"window"`
}

func Defaults() Settings {
	home, _ := os.UserHomeDir()
	docs := filepath.Join(home, "Documents")
	return Settings{
		VaultPath: filepath.Join(docs, AppName),

		Theme:                "light",
		Language:             "zh-CN",
		Zoom:                 100,
		Autostart:            false,
		MinimiseToTray:       true,
		CloseToTray:          false,
		AutoUpdate:           true,
		HardwareAcceleration: true,

		FontFamily:      "system",
		FontSize:        15,
		LineHeight:      1.8,
		TabSize:         4,
		ShowLineNumbers: false,
		AutoSave:        true,
		AutoSaveDelayMs: 800,
		AutoPairing:     true,

		EditorWidth:  "medium",
		ListView:     "list",
		SortBy:       "updated",
		ShowLivePrev: true,

		ExportDir:        docs,
		LastExportFormat: "md",

		Window: WindowState{Width: 1240, Height: 820, X: -1, Y: -1},
	}
}

// Dir is where settings.json lives: %APPDATA%\巧记.
func Dir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base, _ = os.UserHomeDir()
	}
	return filepath.Join(base, AppName)
}

func path() string { return filepath.Join(Dir(), "settings.json") }

type Store struct {
	mu sync.RWMutex
	s  Settings
}

func Load() *Store {
	st := &Store{s: Defaults()}
	data, err := os.ReadFile(path())
	if err != nil {
		return st
	}
	// Editors and PowerShell happily write JSON with a UTF-8 BOM, which the
	// decoder rejects. Silently resetting every preference because of three
	// invisible bytes is not an acceptable failure mode.
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))

	// Unmarshal over the defaults so newly added fields keep sane values when
	// upgrading from an older settings file.
	loaded := Defaults()
	if err := json.Unmarshal(data, &loaded); err != nil {
		return st
	}
	st.s = loaded
	st.s.normalise()
	return st
}

func (s *Settings) normalise() {
	d := Defaults()
	if s.Zoom < 50 || s.Zoom > 200 {
		s.Zoom = d.Zoom
	}
	if s.FontSize < 10 || s.FontSize > 32 {
		s.FontSize = d.FontSize
	}
	if s.LineHeight < 1.0 || s.LineHeight > 3.0 {
		s.LineHeight = d.LineHeight
	}
	if s.TabSize < 1 || s.TabSize > 8 {
		s.TabSize = d.TabSize
	}
	if s.AutoSaveDelayMs < 200 || s.AutoSaveDelayMs > 10000 {
		s.AutoSaveDelayMs = d.AutoSaveDelayMs
	}
	switch s.Theme {
	case "light", "dark", "system":
	default:
		s.Theme = d.Theme
	}
	switch s.EditorWidth {
	case "narrow", "medium", "wide", "full":
	default:
		s.EditorWidth = d.EditorWidth
	}
	switch s.ListView {
	case "list", "grid":
	default:
		s.ListView = d.ListView
	}
	switch s.SortBy {
	case "updated", "created", "title":
	default:
		s.SortBy = d.SortBy
	}
	if s.VaultPath == "" {
		s.VaultPath = d.VaultPath
	}
	if s.ExportDir == "" {
		s.ExportDir = d.ExportDir
	}
	if s.Window.Width < 640 {
		s.Window.Width = d.Window.Width
	}
	if s.Window.Height < 480 {
		s.Window.Height = d.Window.Height
	}
}

func (st *Store) Get() Settings {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.s
}

func (st *Store) Set(next Settings) error {
	st.mu.Lock()
	next.normalise()
	// The library path is owned by the vault lifecycle, not the settings form,
	// so callers change it through SetVault instead.
	next.VaultPath = st.s.VaultPath
	st.s = next
	st.mu.Unlock()
	return st.Save()
}

func (st *Store) SetVault(p string) error {
	st.mu.Lock()
	st.s.VaultPath = p
	st.mu.Unlock()
	return st.Save()
}

func (st *Store) SetWindow(w WindowState) {
	st.mu.Lock()
	st.s.Window = w
	st.mu.Unlock()
	_ = st.Save()
}

// Patch applies a mutation under the write lock and persists the result.
func (st *Store) Patch(fn func(*Settings)) error {
	st.mu.Lock()
	fn(&st.s)
	st.s.normalise()
	st.mu.Unlock()
	return st.Save()
}

func (st *Store) Save() error {
	st.mu.RLock()
	data, err := json.MarshalIndent(st.s, "", "  ")
	st.mu.RUnlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return err
	}
	tmp := path() + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path())
}
