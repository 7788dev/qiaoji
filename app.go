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
	ctx         context.Context
	settings    *config.Store
	settingsErr error

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
	open     *vaultSession
	vaultErr string

	// selfWriteUntil marks a window during which filesystem events are almost
	// certainly echoes of our own save, so the UI is told not to treat them as
	// external edits.
	selfWriteUntil atomic.Int64

	// quitRequested distinguishes "close the window" from "exit the app". The
	// close-to-tray preference applies to the former only.
	quitRequested atomic.Bool

	closeMu    sync.Mutex
	closePhase closePhase
	closeDone  chan struct{}
}

// closePhase tracks the two-step window close: the first attempt is vetoed
// while the frontend flushes, and the confirmation releases it.
type closePhase int

const (
	closeIdle closePhase = iota
	closeFlushing
	closeConfirmed
)

// vaultSession owns one open library: the folder, its search index and its
// watcher, for as long as that library is the current one.
//
// Every operation holds the session open while it runs. Without that, opening
// a different library closed the index while queries were still reading from
// it, and the watcher's debounced reindex could fire against a database that
// had just been shut.
type vaultSession struct {
	vault   *store.Vault
	index   *index.Index
	watcher *watch.Watcher

	use    sync.RWMutex
	closed bool
}

// acquire holds the session open, reporting false once it has been closed.
func (s *vaultSession) acquire() bool {
	s.use.RLock()
	if s.closed {
		s.use.RUnlock()
		return false
	}
	return true
}

func (s *vaultSession) release() { s.use.RUnlock() }

func (s *vaultSession) close() {
	// The watcher goes first, and outside the lock: closing it waits for a
	// debounced callback that is itself holding the session open, so doing
	// this under the write lock would deadlock against that callback.
	if s.watcher != nil {
		_ = s.watcher.Close()
		s.watcher = nil
	}

	s.use.Lock()
	s.closed = true
	s.use.Unlock()

	// Every reader has drained, so the index has no users left.
	if s.index != nil {
		_ = s.index.Close()
	}
}

func NewApp() *App {
	settings, err := config.Load()
	return &App{settings: settings, settingsErr: err, started: make(chan struct{})}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	defer a.startOnce.Do(func() { close(a.started) })

	if a.settingsErr != nil {
		a.mu.Lock()
		a.vaultErr = fmt.Sprintf("无法加载设置: %v。请选择原来的笔记库文件夹。", a.settingsErr)
		a.mu.Unlock()
		runtime.LogErrorf(ctx, "load settings: %v", a.settingsErr)
		return
	}

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
	previous := a.open
	a.open = nil
	a.mu.Unlock()

	if previous != nil {
		previous.close()
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
	ready := a.open != nil
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
		// The write-ahead log goes too, or a stale one is replayed into the
		// database we just recreated.
		for _, suffix := range []string{"", "-wal", "-shm"} {
			_ = os.Remove(v.InternalPath("index.db" + suffix))
		}
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

	session := &vaultSession{vault: v, index: ix}
	// The watcher reports changes to this library, so its callback works
	// against this session rather than looking up whichever one is current.
	if w, werr := watch.New(v.Root(), 400*time.Millisecond, func() {
		a.onVaultChanged(session)
	}); werr == nil {
		session.watcher = w
	}

	a.mu.Lock()
	previous := a.open
	a.open = session
	a.vaultErr = ""
	a.mu.Unlock()

	// Closing waits for in-flight queries, so it happens after the swap and
	// outside the lock; new work already goes to the new session.
	if previous != nil {
		previous.close()
	}
	return nil
}

func (a *App) onVaultChanged(s *vaultSession) {
	if !s.acquire() {
		return
	}
	defer s.release()

	changed, err := s.index.Sync(s.vault)
	if err != nil {
		// Discarding this used to turn a persistently failing index into a
		// silently empty note list.
		if a.ctx != nil {
			runtime.LogErrorf(a.ctx, "index sync: %v", err)
		}
		return
	}
	if changed == 0 {
		return
	}
	external := time.Now().UnixMilli() > a.selfWriteUntil.Load()
	a.emit("vault:changed", map[string]any{"external": external, "changed": changed})
}

func (a *App) session() *vaultSession {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.open
}

// need returns the open library plus a release function that must be deferred.
// Holding the session for the whole operation is what keeps a library switch
// from closing the index while this query is still reading from it.
func (a *App) need() (*store.Vault, *index.Index, func(), error) {
	s := a.session()
	if s == nil || !s.acquire() {
		return nil, nil, func() {}, errors.New("尚未打开笔记库")
	}
	return s.vault, s.index, s.release, nil
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
	v, ix, done, err := a.need()
	if err != nil {
		return Stats{}
	}
	defer done()
	folders, _ := v.Folders()
	tags, _ := ix.Tags()
	return a.statsFrom(v, ix, len(folders), len(tags))
}

// statsFrom totals the library from SQL aggregates and a directory count,
// taking the folder and tag totals from a caller that already has them.
func (a *App) statsFrom(v *store.Vault, ix *index.Index, folders, tags int) Stats {
	sum, _ := ix.Summary()
	return Stats{
		Notes:   sum.Notes,
		Words:   sum.Words,
		Bytes:   sum.Bytes,
		Folders: folders,
		Tags:    tags,
		Trash:   v.CountTrash(),
	}
}

// SidebarData is everything the navigation pane draws.
//
// It is one call rather than three because the panel refreshes after every
// note operation: asking separately made each refresh walk the vault twice and
// scan the tag column three times.
type SidebarData struct {
	Folders []store.Folder `json:"folders"`
	Tags    []store.Tag    `json:"tags"`
	Stats   Stats          `json:"stats"`
}

func (a *App) Sidebar() (SidebarData, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return SidebarData{}, err
	}
	defer done()
	folders, err := v.Folders()
	if err != nil {
		return SidebarData{}, err
	}
	tags, err := ix.Tags()
	if err != nil {
		return SidebarData{}, err
	}
	return SidebarData{
		Folders: folders,
		Tags:    tags,
		Stats:   a.statsFrom(v, ix, len(folders), len(tags)),
	}, nil
}

// RebuildIndex throws away the search index and rebuilds it from disk.
func (a *App) RebuildIndex() (Stats, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return Stats{}, err
	}
	defer done()
	if err := ix.Reset(); err != nil {
		return Stats{}, err
	}
	if _, err := ix.Sync(v); err != nil {
		return Stats{}, err
	}
	// Computed here rather than through Stats(): acquiring the session a
	// second time while already holding it would deadlock behind a library
	// switch waiting for its exclusive turn.
	folders, _ := v.Folders()
	tags, _ := ix.Tags()
	return a.statsFrom(v, ix, len(folders), len(tags)), nil
}

// ---------------------------------------------------------------- notes

func (a *App) ListNotes(q index.Query) ([]store.Meta, error) {
	_, ix, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
	return ix.List(q)
}

func (a *App) ListFolders() ([]store.Folder, error) {
	v, _, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
	return v.Folders()
}

func (a *App) ListTags() ([]store.Tag, error) {
	_, ix, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
	return ix.Tags()
}

// GetNote loads a note by path, falling back to its stable id when the file
// was renamed or moved behind our back.
func (a *App) GetNote(path, id string) (store.Note, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Note{}, err
	}
	defer done()
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

func updateIndexedNote(ix *index.Index, n store.Note, previousPath string) error {
	if previousPath != "" && n.Path != previousPath {
		if err := ix.Remove(previousPath); err != nil {
			return fmt.Errorf("移除旧索引失败: %w", err)
		}
	}
	if err := ix.Upsert(n); err != nil {
		return fmt.Errorf("更新搜索索引失败: %w", err)
	}
	return nil
}

func (a *App) CreateNote(folder, title string) (store.Note, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Note{}, err
	}
	defer done()
	a.touch()
	n, err := v.Create(folder, title, "")
	if err != nil {
		return store.Note{}, err
	}
	if err := updateIndexedNote(ix, n, ""); err != nil {
		return n, err
	}
	return n, nil
}

func (a *App) SaveNote(path, content, expectedRevision string, force bool) (store.Meta, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	defer done()
	a.touch()
	n, err := v.SaveIfRevision(path, content, expectedRevision, force)
	if err != nil {
		if errors.Is(err, store.ErrConflict) {
			return store.Meta{}, errors.New("笔记已在磁盘上被修改")
		}
		return store.Meta{}, err
	}
	if err := updateIndexedNote(ix, n, path); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

func (a *App) RenameNote(path, title string) (store.Meta, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	defer done()
	a.touch()
	n, err := v.Rename(path, title)
	if err != nil {
		return store.Meta{}, err
	}
	if err := updateIndexedNote(ix, n, path); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

func (a *App) MoveNote(path, folder string) (store.Meta, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	defer done()
	a.touch()
	n, err := v.Move(path, folder)
	if err != nil {
		return store.Meta{}, err
	}
	if err := updateIndexedNote(ix, n, path); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

func (a *App) DuplicateNote(path string) (store.Meta, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	defer done()
	a.touch()
	n, err := v.Duplicate(path)
	if err != nil {
		return store.Meta{}, err
	}
	if err := updateIndexedNote(ix, n, ""); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

func (a *App) SetFavorite(path string, favorite bool) (store.Meta, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	defer done()
	a.touch()
	n, err := v.SetFavorite(path, favorite)
	if err != nil {
		return store.Meta{}, err
	}
	if err := updateIndexedNote(ix, n, ""); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

func (a *App) SetNoteTags(path string, tags []string) (store.Meta, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Meta{}, err
	}
	defer done()
	a.touch()
	n, err := v.SetTags(path, tags)
	if err != nil {
		return store.Meta{}, err
	}
	if err := updateIndexedNote(ix, n, ""); err != nil {
		return n.Meta, err
	}
	return n.Meta, nil
}

// DeleteNote moves a note to the trash and returns the entry it became, so
// "undo" can restore exactly that entry instead of guessing from a path.
func (a *App) DeleteNote(path string) (store.TrashItem, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.TrashItem{}, err
	}
	defer done()
	a.touch()
	item, err := v.Trash(path)
	if err != nil {
		return store.TrashItem{}, err
	}
	return item, ix.Remove(path)
}

// ---------------------------------------------------------------- trash

func (a *App) ListTrash() ([]store.TrashItem, error) {
	v, _, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
	return v.ListTrash()
}

// RestoreNote puts a trash entry back. An entry can be a single note or a
// whole folder, so the result says which came back.
func (a *App) RestoreNote(entryID string) (store.Restored, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.Restored{}, err
	}
	defer done()
	a.touch()
	out, err := v.Restore(entryID)
	if err != nil {
		return store.Restored{}, err
	}
	if out.Kind == store.TrashFolder {
		// The restored notes are absent from the index, so a stat walk picks
		// up exactly them and leaves the rest of the library alone.
		if _, err := ix.Sync(v); err != nil {
			return out, fmt.Errorf("恢复后的索引同步失败: %w", err)
		}
		return out, nil
	}
	if err := updateIndexedNote(ix, out.Note, ""); err != nil {
		return out, err
	}
	return out, nil
}

func (a *App) PurgeTrashItem(entryID string) error {
	v, _, done, err := a.need()
	if err != nil {
		return err
	}
	defer done()
	return v.PurgeTrash(entryID)
}

func (a *App) EmptyTrash() error {
	v, _, done, err := a.need()
	if err != nil {
		return err
	}
	defer done()
	return v.EmptyTrash()
}

// ---------------------------------------------------------------- folders

func (a *App) CreateFolder(name string) (store.Folder, error) {
	v, _, done, err := a.need()
	if err != nil {
		return store.Folder{}, err
	}
	defer done()
	a.touch()
	f, err := v.CreateFolder(name)
	if errors.Is(err, store.ErrExists) {
		return store.Folder{}, errors.New("已存在同名文件夹")
	}
	return f, err
}

func (a *App) RenameFolder(rel, name string) error {
	v, ix, done, err := a.need()
	if err != nil {
		return err
	}
	defer done()
	a.touch()
	if err := v.RenameFolder(rel, name); err != nil {
		if errors.Is(err, store.ErrExists) {
			return errors.New("已存在同名文件夹")
		}
		return err
	}
	// Only the moved subtree is dropped; the following stat walk re-reads
	// those notes and nothing else. Rebuilding the whole index here cost the
	// full cold-start price for renaming one directory.
	if err := ix.RemoveUnder(rel); err != nil {
		return err
	}
	_, err = ix.Sync(v)
	return err
}

// DeleteFolder moves a folder and everything inside it to the trash as one
// entry, so attachments come back with the notes.
func (a *App) DeleteFolder(rel string) (store.TrashItem, error) {
	v, ix, done, err := a.need()
	if err != nil {
		return store.TrashItem{}, err
	}
	defer done()
	a.touch()
	item, err := v.DeleteFolder(rel)
	if err != nil {
		return store.TrashItem{}, err
	}
	return item, ix.RemoveUnder(rel)
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
	v, ix, done, err := a.need()
	if err != nil {
		return 0, err
	}
	defer done()
	metas, err := ix.List(index.Query{Scope: "tag", Value: name, Limit: 100000})
	if err != nil {
		return 0, err
	}
	a.touch()
	n := 0
	for _, m := range metas {
		note, err := v.SetTags(m.Path, fn(m.Tags))
		if err != nil {
			return n, err
		}
		if err := updateIndexedNote(ix, note, ""); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// ---------------------------------------------------------------- search

func (a *App) Search(query string, limit int) ([]index.Hit, error) {
	_, ix, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
	return ix.Search(index.NormaliseQuery(query), limit)
}

func (a *App) Suggest(query string, limit int) ([]store.Meta, error) {
	_, ix, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
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
	v, _, done, err := a.need()
	if err != nil {
		return nil, err
	}
	defer done()
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
