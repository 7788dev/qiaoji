package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"qiaoji/internal/config"
	"qiaoji/internal/exporter"
	"qiaoji/internal/index"
	"qiaoji/internal/store"
	"qiaoji/internal/watch"
)

// App is the API surface bound to the frontend. Every exported method here
// becomes a callable in frontend/wailsjs/go/main/App.
type App struct {
	ctx      context.Context
	settings *config.Store

	// tray is set before Run so window commands can ask whether hiding to the
	// notification area is actually safe.
	tray *tray

	// started is closed once the initial library open has finished, whether it
	// succeeded or not. Wails runs OnStartup concurrently with the frontend
	// loading, so without this the first Bootstrap call can observe a half-open
	// app and report a failure for a perfectly healthy library.
	started   chan struct{}
	startOnce sync.Once

	mu       sync.RWMutex
	vault    *store.Vault
	index    *index.Index
	watcher  *watch.Watcher
	vaultErr string

	// selfWriteUntil marks a window during which filesystem events are almost
	// certainly echoes of our own save, so the UI is told not to treat them as
	// external edits.
	selfWriteUntil atomic.Int64
}

func NewApp() *App {
	return &App{settings: config.Load(), started: make(chan struct{})}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	defer a.startOnce.Do(func() { close(a.started) })

	// There is no welcome screen: the app always opens a library on launch and
	// writes the starter notes the first time that folder is used.
	if err := a.openVault(a.settings.Get().VaultPath); err != nil {
		a.mu.Lock()
		a.vaultErr = err.Error()
		a.mu.Unlock()
		runtime.LogErrorf(ctx, "open vault: %v", err)
	}
}

// waitForStartup blocks until the initial library open has finished.
//
// The ceiling exists so a genuinely stuck filesystem (a disconnected network
// drive) still reaches the error screen instead of leaving a blank window.
func (a *App) waitForStartup() {
	select {
	case <-a.started:
	case <-time.After(30 * time.Second):
	}
}

func (a *App) shutdown(context.Context) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.watcher != nil {
		_ = a.watcher.Close()
		a.watcher = nil
	}
	if a.index != nil {
		_ = a.index.Close()
		a.index = nil
	}
}

// ---------------------------------------------------------------- payloads

type Stats struct {
	Notes   int   `json:"notes"`
	Words   int   `json:"words"`
	Folders int   `json:"folders"`
	Tags    int   `json:"tags"`
	Trash   int   `json:"trash"`
	Bytes   int64 `json:"bytes"`
}

type Bootstrap struct {
	Settings   config.Settings `json:"settings"`
	VaultReady bool            `json:"vaultReady"`
	VaultPath  string          `json:"vaultPath"`
	Version    string          `json:"version"`
	Error      string          `json:"error"`
	Stats      Stats           `json:"stats"`
}

func (a *App) Bootstrap() Bootstrap {
	a.waitForStartup()

	s := a.settings.Get()
	out := Bootstrap{
		Settings:  s,
		VaultPath: s.VaultPath,
		Version:   config.AppVersion,
	}
	a.mu.RLock()
	ready := a.vault != nil
	out.Error = a.vaultErr
	a.mu.RUnlock()
	out.VaultReady = ready
	if ready {
		out.Stats = a.Stats()
	}
	// The Run key can be cleared by the user or by a cleanup tool, so the
	// checkbox reflects the registry rather than our own last write.
	if actual := config.AutostartEnabled(); actual != out.Settings.Autostart {
		out.Settings.Autostart = actual
		_ = a.settings.Patch(func(s *config.Settings) { s.Autostart = actual })
	}
	return out
}

// ---------------------------------------------------------------- vault

// OpenVault switches to a different folder, used by the setting that changes
// the library location.
func (a *App) OpenVault(path string) (Bootstrap, error) {
	if strings.TrimSpace(path) == "" {
		return a.Bootstrap(), errors.New("请选择一个笔记库文件夹")
	}
	if err := a.openVault(path); err != nil {
		return a.Bootstrap(), err
	}
	if err := a.settings.SetVault(path); err != nil {
		return a.Bootstrap(), err
	}
	return a.Bootstrap(), nil
}

func (a *App) openVault(path string) error {
	if strings.TrimSpace(path) == "" {
		path = config.Defaults().VaultPath
	}
	v, err := store.Open(path)
	if err != nil {
		return fmt.Errorf("无法打开笔记库: %w", err)
	}

	// Starter notes are written exactly once per folder. Emptying the library
	// afterwards leaves it empty, which is what someone who deleted every note
	// is asking for.
	if !v.IsInitialised() {
		if v.IsEmpty() {
			if err := v.Seed(); err != nil {
				return fmt.Errorf("初始化示例笔记失败: %w", err)
			}
		}
		if err := v.MarkInitialised(); err != nil {
			return fmt.Errorf("初始化笔记库失败: %w", err)
		}
	}

	ix, err := index.Open(v.InternalPath("index.db"))
	if err != nil {
		// A corrupt index must never block startup; the vault is the truth.
		_ = os.Remove(v.InternalPath("index.db"))
		ix, err = index.Open(v.InternalPath("index.db"))
		if err != nil {
			return fmt.Errorf("无法建立搜索索引: %w", err)
		}
	}
	if _, err := ix.Sync(v); err != nil {
		if rerr := ix.Reset(); rerr == nil {
			_, _ = ix.Sync(v)
		}
	}

	a.mu.Lock()
	if a.watcher != nil {
		_ = a.watcher.Close()
	}
	if a.index != nil {
		_ = a.index.Close()
	}
	a.vault, a.index = v, ix
	a.vaultErr = ""
	a.mu.Unlock()

	w, err := watch.New(v.Root(), 400*time.Millisecond, a.onVaultChanged)
	if err == nil {
		a.mu.Lock()
		a.watcher = w
		a.mu.Unlock()
	}
	return nil
}

func (a *App) onVaultChanged() {
	v, ix := a.current()
	if v == nil || ix == nil {
		return
	}
	changed, err := ix.Sync(v)
	if err != nil || changed == 0 {
		return
	}
	external := time.Now().UnixMilli() > a.selfWriteUntil.Load()
	a.emit("vault:changed", map[string]any{"external": external, "changed": changed})
}

func (a *App) current() (*store.Vault, *index.Index) {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.vault, a.index
}

func (a *App) need() (*store.Vault, *index.Index, error) {
	v, ix := a.current()
	if v == nil || ix == nil {
		return nil, nil, errors.New("尚未打开笔记库")
	}
	return v, ix, nil
}

func (a *App) emit(name string, payload any) {
	if a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, name, payload)
}

// touch widens the window in which filesystem events count as our own.
func (a *App) touch() {
	a.selfWriteUntil.Store(time.Now().Add(1500 * time.Millisecond).UnixMilli())
}

// SelectVaultDir opens the native folder picker.
func (a *App) SelectVaultDir() (string, error) {
	s := a.settings.Get()
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                "选择笔记库文件夹",
		DefaultDirectory:     filepath.Dir(s.VaultPath),
		CanCreateDirectories: true,
	})
}

func (a *App) Stats() Stats {
	v, ix, err := a.need()
	if err != nil {
		return Stats{}
	}
	metas, _ := ix.List(index.Query{Scope: "all", SortBy: "updated", Limit: 100000})
	folders, _ := v.Folders()
	tags, _ := ix.Tags()
	trash, _ := v.ListTrash()

	out := Stats{
		Notes:   len(metas),
		Folders: len(folders),
		Tags:    len(tags),
		Trash:   len(trash),
	}
	for _, m := range metas {
		out.Words += m.Words
		out.Bytes += m.Size
	}
	return out
}

// RebuildIndex throws away the search index and rebuilds it from disk.
func (a *App) RebuildIndex() (Stats, error) {
	v, ix, err := a.need()
	if err != nil {
		return Stats{}, err
	}
	if err := ix.Reset(); err != nil {
		return Stats{}, err
	}
	if _, err := ix.Sync(v); err != nil {
		return Stats{}, err
	}
	return a.Stats(), nil
}

// ---------------------------------------------------------------- notes

func (a *App) ListNotes(q index.Query) ([]store.Meta, error) {
	_, ix, err := a.need()
	if err != nil {
		return nil, err
	}
	return ix.List(q)
}

func (a *App) ListFolders() ([]store.Folder, error) {
	v, _, err := a.need()
	if err != nil {
		return nil, err
	}
	return v.Folders()
}

func (a *App) ListTags() ([]store.Tag, error) {
	_, ix, err := a.need()
	if err != nil {
		return nil, err
	}
	return ix.Tags()
}

// GetNote loads a note by path, falling back to its stable id when the file
// was renamed or moved behind our back.
func (a *App) GetNote(path, id string) (store.Note, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Note{}, err
	}
	n, err := v.Read(path)
	if err == nil {
		return n, nil
	}
	if id == "" {
		return store.Note{}, err
	}
	resolved, rerr := ix.PathByID(id)
	if rerr != nil || resolved == "" {
		return store.Note{}, err
	}
	return v.Read(resolved)
}

func (a *App) CreateNote(folder, title string) (store.Note, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Note{}, err
	}
	a.touch()
	n, err := v.Create(folder, title, "")
	if err != nil {
		return store.Note{}, err
	}
	_ = ix.Upsert(n)
	return n, nil
}

func (a *App) SaveNote(path, content string) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.Save(path, content)
	if err != nil {
		return store.Meta{}, err
	}
	if n.Path != path {
		_ = ix.Remove(path)
	}
	if err := ix.Upsert(n); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

func (a *App) RenameNote(path, title string) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.Rename(path, title)
	if err != nil {
		return store.Meta{}, err
	}
	if n.Path != path {
		_ = ix.Remove(path)
	}
	_ = ix.Upsert(n)
	return n.Meta, nil
}

func (a *App) MoveNote(path, folder string) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.Move(path, folder)
	if err != nil {
		return store.Meta{}, err
	}
	if n.Path != path {
		_ = ix.Remove(path)
	}
	_ = ix.Upsert(n)
	return n.Meta, nil
}

func (a *App) DuplicateNote(path string) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.Duplicate(path)
	if err != nil {
		return store.Meta{}, err
	}
	_ = ix.Upsert(n)
	return n.Meta, nil
}

func (a *App) SetFavorite(path string, favorite bool) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.SetFavorite(path, favorite)
	if err != nil {
		return store.Meta{}, err
	}
	_ = ix.Upsert(n)
	return n.Meta, nil
}

func (a *App) SetNoteTags(path string, tags []string) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.SetTags(path, tags)
	if err != nil {
		return store.Meta{}, err
	}
	_ = ix.Upsert(n)
	return n.Meta, nil
}

func (a *App) DeleteNote(path string) error {
	v, ix, err := a.need()
	if err != nil {
		return err
	}
	a.touch()
	if _, err := v.Trash(path); err != nil {
		return err
	}
	return ix.Remove(path)
}

// ---------------------------------------------------------------- trash

func (a *App) ListTrash() ([]store.TrashItem, error) {
	v, _, err := a.need()
	if err != nil {
		return nil, err
	}
	return v.ListTrash()
}

func (a *App) RestoreNote(entryID string) (store.Meta, error) {
	v, ix, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	a.touch()
	n, err := v.Restore(entryID)
	if err != nil {
		return store.Meta{}, err
	}
	_ = ix.Upsert(n)
	return n.Meta, nil
}

func (a *App) PurgeTrashItem(entryID string) error {
	v, _, err := a.need()
	if err != nil {
		return err
	}
	return v.PurgeTrash(entryID)
}

func (a *App) EmptyTrash() error {
	v, _, err := a.need()
	if err != nil {
		return err
	}
	return v.EmptyTrash()
}

// ---------------------------------------------------------------- folders

func (a *App) CreateFolder(name string) (store.Folder, error) {
	v, _, err := a.need()
	if err != nil {
		return store.Folder{}, err
	}
	a.touch()
	f, err := v.CreateFolder(name)
	if errors.Is(err, store.ErrExists) {
		return store.Folder{}, errors.New("已存在同名文件夹")
	}
	return f, err
}

func (a *App) RenameFolder(rel, name string) error {
	v, ix, err := a.need()
	if err != nil {
		return err
	}
	a.touch()
	if err := v.RenameFolder(rel, name); err != nil {
		if errors.Is(err, store.ErrExists) {
			return errors.New("已存在同名文件夹")
		}
		return err
	}
	_ = ix.Reset()
	_, err = ix.Sync(v)
	return err
}

func (a *App) DeleteFolder(rel string) error {
	v, ix, err := a.need()
	if err != nil {
		return err
	}
	a.touch()
	if err := v.DeleteFolder(rel); err != nil {
		return err
	}
	_ = ix.Reset()
	_, err = ix.Sync(v)
	return err
}

// ---------------------------------------------------------------- tags

// RenameTag rewrites the tag across every note that carries it.
func (a *App) RenameTag(oldName, newName string) (int, error) {
	newName = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(newName), "#"))
	if newName == "" {
		return 0, errors.New("标签名不能为空")
	}
	return a.mutateTag(oldName, func(tags []string) []string {
		out := make([]string, 0, len(tags))
		for _, t := range tags {
			if t == oldName {
				t = newName
			}
			out = append(out, t)
		}
		return out
	})
}

func (a *App) DeleteTag(name string) (int, error) {
	return a.mutateTag(name, func(tags []string) []string {
		out := make([]string, 0, len(tags))
		for _, t := range tags {
			if t != name {
				out = append(out, t)
			}
		}
		return out
	})
}

func (a *App) mutateTag(name string, fn func([]string) []string) (int, error) {
	v, ix, err := a.need()
	if err != nil {
		return 0, err
	}
	metas, err := ix.List(index.Query{Scope: "tag", Value: name, Limit: 100000})
	if err != nil {
		return 0, err
	}
	a.touch()
	n := 0
	for _, m := range metas {
		note, err := v.SetTags(m.Path, fn(m.Tags))
		if err != nil {
			continue
		}
		_ = ix.Upsert(note)
		n++
	}
	return n, nil
}

// ---------------------------------------------------------------- search

func (a *App) Search(query string, limit int) ([]index.Hit, error) {
	_, ix, err := a.need()
	if err != nil {
		return nil, err
	}
	return ix.Search(index.NormaliseQuery(query), limit)
}

func (a *App) Suggest(query string, limit int) ([]store.Meta, error) {
	_, ix, err := a.need()
	if err != nil {
		return nil, err
	}
	return ix.Suggest(index.NormaliseQuery(query), limit)
}

// ---------------------------------------------------------------- settings

func (a *App) GetSettings() config.Settings { return a.settings.Get() }

func (a *App) SaveSettings(next config.Settings) (config.Settings, error) {
	prev := a.settings.Get()
	if err := a.settings.Set(next); err != nil {
		return prev, err
	}
	applied := a.settings.Get()
	if applied.Autostart != prev.Autostart {
		if err := config.ApplyAutostart(applied.Autostart); err != nil {
			// Registry access can fail under restrictive policies; keep the
			// rest of the settings and report just this part.
			return applied, fmt.Errorf("开机自启设置失败: %w", err)
		}
	}
	return applied, nil
}

// ---------------------------------------------------------------- export

func (a *App) SelectExportDir() (string, error) {
	s := a.settings.Get()
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                "选择保存位置",
		DefaultDirectory:     s.ExportDir,
		CanCreateDirectories: true,
	})
	if err != nil || dir == "" {
		return dir, err
	}
	_ = a.settings.Patch(func(cur *config.Settings) { cur.ExportDir = dir })
	return dir, nil
}

func (a *App) Export(req exporter.Request) (string, error) {
	if req.Dir == "" {
		req.Dir = a.settings.Get().ExportDir
	}
	out, err := exporter.Run(req)
	if err != nil {
		return "", err
	}
	_ = a.settings.Patch(func(cur *config.Settings) {
		cur.ExportDir = req.Dir
		cur.LastExportFormat = string(req.Format)
	})
	return out, nil
}

// ---------------------------------------------------------------- shell

// RevealInExplorer selects the file in Explorer rather than opening it, which
// is what users expect from "show in folder".
func (a *App) RevealInExplorer(path string) error {
	if path == "" {
		return errors.New("路径为空")
	}
	if _, err := os.Stat(path); err != nil {
		return errors.New("文件不存在")
	}
	return revealInFileManager(path)
}

func (a *App) OpenPath(path string) error {
	if _, err := os.Stat(path); err != nil {
		return errors.New("文件不存在")
	}
	return openWithDefaultApp(path)
}

func (a *App) OpenExternal(url string) error {
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
		return errors.New("仅支持打开 http/https 链接")
	}
	runtime.BrowserOpenURL(a.ctx, url)
	return nil
}

// ---------------------------------------------------------------- window

func (a *App) SaveWindowState(width, height, x, y int, maximised bool) {
	a.settings.SetWindow(config.WindowState{
		Width: width, Height: height, X: x, Y: y, Maximised: maximised,
	})
}

// SortedFolderNames is used by the "move to folder" picker.
func (a *App) SortedFolderNames() ([]string, error) {
	v, _, err := a.need()
	if err != nil {
		return nil, err
	}
	folders, err := v.Folders()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(folders)+1)
	out = append(out, "")
	for _, f := range folders {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out, nil
}
