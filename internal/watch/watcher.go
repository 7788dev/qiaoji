// Package watch reports vault changes made outside the app (a synced folder,
// another editor or Explorer). It emits paths so the index can update only
// the affected files and directories.
package watch

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// ChangeSet is a lossless, mergeable representation of a burst of file system
// notifications. Paths are absolute and de-duplicated when delivered.
type ChangeSet struct {
	Created  []string `json:"created,omitempty"`
	Modified []string `json:"modified,omitempty"`
	Removed  []string `json:"removed,omitempty"`
	Renamed  []string `json:"renamed,omitempty"`
	Dirs     []string `json:"dirs,omitempty"`
	Overflow bool     `json:"overflow,omitempty"`
	Unknown  bool     `json:"unknown,omitempty"`
}

func (c ChangeSet) Empty() bool {
	return len(c.Created) == 0 && len(c.Modified) == 0 && len(c.Removed) == 0 &&
		len(c.Renamed) == 0 && len(c.Dirs) == 0 && !c.Overflow && !c.Unknown
}

// Merge combines another burst. Keeping a path in more than one operation is
// intentional: a rename followed by a create can be observed as two events.
func (c *ChangeSet) Merge(other ChangeSet) {
	if c == nil {
		return
	}
	c.Created = appendUnique(c.Created, other.Created...)
	c.Modified = appendUnique(c.Modified, other.Modified...)
	c.Removed = appendUnique(c.Removed, other.Removed...)
	c.Renamed = appendUnique(c.Renamed, other.Renamed...)
	c.Dirs = appendUnique(c.Dirs, other.Dirs...)
	c.Overflow = c.Overflow || other.Overflow
	c.Unknown = c.Unknown || other.Unknown
}

func appendUnique(dst []string, values ...string) []string {
	seen := make(map[string]struct{}, len(dst)+len(values))
	for _, p := range dst {
		seen[p] = struct{}{}
	}
	for _, p := range values {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		dst = append(dst, p)
	}
	sort.Strings(dst)
	return dst
}

// Paths returns all paths in deterministic order.
func (c ChangeSet) Paths() []string {
	paths := make([]string, 0, len(c.Created)+len(c.Modified)+len(c.Removed)+len(c.Renamed)+len(c.Dirs))
	paths = append(paths, c.Created...)
	paths = append(paths, c.Modified...)
	paths = append(paths, c.Removed...)
	paths = append(paths, c.Renamed...)
	paths = append(paths, c.Dirs...)
	return appendUnique(nil, paths...)
}

// Watcher coalesces filesystem noise into one callback per quiet period.
type Watcher struct {
	w        *fsnotify.Watcher
	root     string
	debounce time.Duration
	onChange func(ChangeSet)

	mu      sync.Mutex
	timer   *time.Timer
	closed  bool
	stopped chan struct{}
	pending ChangeSet
	dirs    map[string]struct{}
	options Options

	running sync.WaitGroup
	gen     uint64
}

// Options adds project-specific generated paths without changing ordinary
// Markdown vault semantics. Names are matched case-insensitively.
type Options struct {
	IgnoreDirs  []string
	IgnoreFiles []string
}

// New preserves the original callback API. NewWithChanges is the path-aware
// API used by the incremental index.
func New(root string, debounce time.Duration, onChange func()) (*Watcher, error) {
	return NewWithChanges(root, debounce, func(ChangeSet) {
		if onChange != nil {
			onChange()
		}
	})
}

func NewWithChanges(root string, debounce time.Duration, onChange func(ChangeSet)) (*Watcher, error) {
	return NewWithOptions(root, debounce, Options{}, onChange)
}

func NewWithOptions(root string, debounce time.Duration, options Options, onChange func(ChangeSet)) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		_ = fw.Close()
		return nil, err
	}
	w := &Watcher{
		w:        fw,
		root:     filepath.Clean(abs),
		debounce: debounce,
		onChange: onChange,
		stopped:  make(chan struct{}),
		dirs:     make(map[string]struct{}),
		options:  options,
	}
	if err := w.addTree(w.root); err != nil {
		_ = fw.Close()
		return nil, err
	}
	go w.loop()
	return w, nil
}

func (w *Watcher) addTree(root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if p != w.root && w.ignoreDirName(name) {
			return fs.SkipDir
		}
		if err := w.w.Add(p); err != nil {
			return err
		}
		w.mu.Lock()
		w.dirs[filepath.Clean(p)] = struct{}{}
		w.mu.Unlock()
		return nil
	})
}

func (w *Watcher) loop() {
	defer close(w.stopped)
	for {
		select {
		case ev, ok := <-w.w.Events:
			if !ok {
				return
			}
			if w.ignore(ev.Name) {
				continue
			}
			if ev.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					if err := w.addTree(ev.Name); err != nil {
						w.schedule(ChangeSet{Unknown: true})
					}
				}
			}
			w.record(ev)
		case _, ok := <-w.w.Errors:
			if !ok {
				return
			}
			w.schedule(ChangeSet{Overflow: true})
		}
	}
}

func (w *Watcher) record(ev fsnotify.Event) {
	path, err := filepath.Abs(ev.Name)
	if err != nil {
		w.schedule(ChangeSet{Unknown: true})
		return
	}
	path = filepath.Clean(path)
	isDir := false
	if st, statErr := os.Stat(path); statErr == nil {
		isDir = st.IsDir()
	} else {
		w.mu.Lock()
		_, isDir = w.dirs[path]
		w.mu.Unlock()
	}
	var cs ChangeSet
	switch {
	case ev.Op&fsnotify.Rename != 0:
		cs.Renamed = []string{path}
	case ev.Op&fsnotify.Remove != 0:
		cs.Removed = []string{path}
	case ev.Op&fsnotify.Create != 0:
		cs.Created = []string{path}
	case ev.Op&fsnotify.Write != 0 || ev.Op&fsnotify.Chmod != 0:
		cs.Modified = []string{path}
	default:
		cs.Unknown = true
	}
	if isDir {
		cs.Dirs = []string{path}
	}
	w.schedule(cs)
}

func (w *Watcher) ignore(p string) bool {
	base := filepath.Base(p)
	if strings.HasSuffix(base, ".tmp") || strings.HasPrefix(base, "~") {
		return true
	}
	rel, err := filepath.Rel(w.root, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true
	}
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if w.ignoreDirName(seg) {
			return true
		}
	}
	for _, name := range w.options.IgnoreFiles {
		if strings.EqualFold(base, name) {
			return true
		}
	}
	return false
}

func (w *Watcher) ignoreDirName(name string) bool {
	if strings.HasPrefix(name, ".") && name != "." {
		return true
	}
	if strings.EqualFold(name, "node_modules") {
		return true
	}
	for _, ignored := range w.options.IgnoreDirs {
		if strings.EqualFold(name, ignored) {
			return true
		}
	}
	return false
}

func (w *Watcher) schedule(cs ChangeSet) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.pending.Merge(cs)
	if w.timer != nil {
		w.timer.Stop()
	}
	w.gen++
	gen := w.gen
	w.timer = time.AfterFunc(w.debounce, func() {
		w.mu.Lock()
		if w.closed || gen != w.gen || w.onChange == nil {
			w.mu.Unlock()
			return
		}
		pending := w.pending
		w.pending = ChangeSet{}
		w.running.Add(1)
		w.mu.Unlock()
		defer w.running.Done()
		w.onChange(pending)
	})
}

// Close stops watching and waits for callbacks already running.
func (w *Watcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.mu.Unlock()
	err := w.w.Close()
	<-w.stopped
	w.running.Wait()
	return err
}
