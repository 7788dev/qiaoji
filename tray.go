package main

import (
	"context"
	"sync"

	"fyne.io/systray"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// tray runs the notification-area icon. It is deliberately fault tolerant:
// a shell that refuses to register the icon must not take the app down with
// it, so every failure path just leaves the app running without a tray.
type tray struct {
	icon []byte

	mu      sync.Mutex
	started bool
	ready   bool
	quit    func()
}

func newTray(icon []byte) *tray { return &tray{icon: icon} }

// Available reports whether the notification-area icon actually registered.
// Hiding the window to a tray that is not there would strand the user with a
// running process and no way to reach it.
func (t *tray) Available() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.ready
}

func (t *tray) start(ctx context.Context, app *App) {
	t.mu.Lock()
	if t.started || len(t.icon) == 0 {
		t.mu.Unlock()
		return
	}
	t.started = true
	t.mu.Unlock()

	go func() {
		defer func() {
			// systray talks to the Win32 shell; a panic there is recoverable
			// for us because the tray is a convenience, not a dependency.
			if r := recover(); r != nil {
				wruntime.LogWarningf(ctx, "tray unavailable: %v", r)
			}
		}()

		onReady := func() {
			systray.SetIcon(t.icon)
			systray.SetTitle("巧记")
			systray.SetTooltip("巧记 — 轻量 · 高效 · 专注")

			t.mu.Lock()
			t.ready = true
			t.mu.Unlock()

			mShow := systray.AddMenuItem("显示主窗口", "打开巧记")
			mNew := systray.AddMenuItem("新建笔记", "创建一篇新笔记")
			systray.AddSeparator()
			mQuit := systray.AddMenuItem("退出", "退出巧记")

			go func() {
				for {
					select {
					case <-mShow.ClickedCh:
						showWindow(ctx)
					case <-mNew.ClickedCh:
						showWindow(ctx)
						app.emit("tray:new-note", nil)
					case <-mQuit.ClickedCh:
						app.persistWindow(ctx)
						wruntime.Quit(ctx)
						return
					case <-ctx.Done():
						return
					}
				}
			}()
		}

		start, stop := systray.RunWithExternalLoop(onReady, func() {})
		t.mu.Lock()
		t.quit = stop
		t.mu.Unlock()
		start()
	}()
}

func (t *tray) stop() {
	t.mu.Lock()
	quit := t.quit
	t.quit = nil
	t.mu.Unlock()
	if quit != nil {
		func() {
			defer func() { _ = recover() }()
			quit()
		}()
	}
}

func showWindow(ctx context.Context) {
	wruntime.WindowShow(ctx)
	wruntime.WindowUnminimise(ctx)
}
