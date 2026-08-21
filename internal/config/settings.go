// Package config persists user settings outside the vault, so the app can still
// start and show the welcome screen when the vault folder is missing or moved.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const AppName = "巧记"

// AppVersion is replaced by release builds with:
// -ldflags "-X qiaoji/internal/config.AppVersion=<tag version>"
var AppVersion = "dev"

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
	SidebarWidth int    `json:"sidebarWidth"`
	ListWidth    int    `json:"listWidth"`

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
		SidebarWidth: 208,
		ListWidth:    292,

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

// IndexDir is the disposable cache directory for one Markdown vault.
func IndexDir(vaultID string) string { return filepath.Join(Dir(), "indexes", vaultID) }

type Store struct {
	mu     sync.RWMutex
	saveMu sync.Mutex
	path   string
	s      Settings
}

func Load() (*Store, error) {
	return load(path())
}

func load(settingsPath string) (*Store, error) {
	st := &Store{path: settingsPath, s: Defaults()}
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return st, nil
		}
		return st, fmt.Errorf("读取设置失败: %w", err)
	}
	// Editors and PowerShell happily write JSON with a UTF-8 BOM, which the
	// decoder rejects. Silently resetting every preference because of three
	// invisible bytes is not an acceptable failure mode.
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))

	// Unmarshal over the defaults so newly added fields keep sane values when
	// upgrading from an older settings file.
	loaded := Defaults()
	if err := json.Unmarshal(data, &loaded); err != nil {
		backup := fmt.Sprintf("%s.corrupt-%s", settingsPath, time.Now().Format("20060102-150405.000000000"))
		if renameErr := os.Rename(settingsPath, backup); renameErr != nil {
			return st, fmt.Errorf("设置文件损坏（%v），且无法备份原文件: %w", err, renameErr)
		}
		return st, fmt.Errorf("设置文件损坏，已备份到 %s: %w", backup, err)
	}
	st.s = loaded
	st.s.normalise()
	return st, nil
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
	if s.SidebarWidth < 152 || s.SidebarWidth > 360 {
		s.SidebarWidth = d.SidebarWidth
	}
	if s.ListWidth < 200 || s.ListWidth > 520 {
		s.ListWidth = d.ListWidth
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
	st.saveMu.Lock()
	defer st.saveMu.Unlock()

	st.mu.RLock()
	data, err := json.MarshalIndent(st.s, "", "  ")
	st.mu.RUnlock()
	if err != nil {
		return err
	}
	dir := filepath.Dir(st.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".settings-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}
	if err := tmp.Chmod(0o644); err != nil {
		cleanup()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, st.path); err != nil {
		_ = os.Remove(tmpName)
		return err
	}
	return nil
}
