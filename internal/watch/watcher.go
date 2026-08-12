// Package watch reports vault changes made outside the app (a synced folder, a
// different editor, Explorer) so the UI can refresh itself.
package watch

import (
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher coalesces filesystem noise into one callback per quiet period.
// Editors routinely emit half a dozen events for a single save, and cloud
// sync clients emit far more, so debouncing is what keeps this cheap.
type Watcher struct {
	w        *fsnotify.Watcher
	root     string
	debounce time.Duration
	onChange func()

	mu      sync.Mutex
	timer   *time.Timer
	closed  bool
	stopped chan struct{}
}

func New(root string, debounce time.Duration, onChange func()) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		w:        fw,
		root:     root,
		debounce: debounce,
		onChange: onChange,
		stopped:  make(chan struct{}),
	}
	if err := w.addTree(root); err != nil {
		fw.Close()
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
		if p != root && (strings.HasPrefix(name, ".") || name == "node_modules") {
			return fs.SkipDir
		}
		_ = w.w.Add(p)
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
			// A new folder has to be watched too, otherwise notes created
			// inside it are invisible until restart.
			if ev.Op&fsnotify.Create != 0 {
				if info, err := filepath.Abs(ev.Name); err == nil {
					_ = w.addIfDir(info)
				}
			}
			w.schedule()
		case _, ok := <-w.w.Errors:
			if !ok {
				return
			}
		}
	}
}

func (w *Watcher) addIfDir(p string) error {
	st, err := filepathStat(p)
	if err != nil || !st {
		return err
	}
	return w.addTree(p)
}

func (w *Watcher) ignore(p string) bool {
	base := filepath.Base(p)
	if strings.HasSuffix(base, ".tmp") || strings.HasPrefix(base, "~") {
		return true
	}
	rel, err := filepath.Rel(w.root, p)
	if err != nil {
		return true
	}
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if strings.HasPrefix(seg, ".") && seg != "." {
			return true
		}
	}
	return false
}

func (w *Watcher) schedule() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(w.debounce, func() {
		w.mu.Lock()
		closed := w.closed
		w.mu.Unlock()
		if !closed && w.onChange != nil {
			w.onChange()
		}
	})
}

// Pause suppresses callbacks while the app itself is writing, so our own saves
// do not bounce back as external changes.
func (w *Watcher) Pause() {
	w.mu.Lock()
	if w.timer != nil {
		w.timer.Stop()
		w.timer = nil
	}
	w.mu.Unlock()
}

func (w *Watcher) Close() error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return nil
	}
	w.closed = true
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
	err := w.w.Close()
	<-w.stopped
	return err
}
