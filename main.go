package main

import (
	"context"
	"embed"
	"net/http"
	"os"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"qiaoji/internal/config"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/windows/icon.ico
var trayIcon []byte

func main() {
	app := NewApp()
	s := app.settings.Get()

	// --tray is appended to the autostart entry so a boot launch stays out of
	// the way until the user asks for the window.
	startHidden := hasFlag("--tray") && s.MinimiseToTray

	tray := newTray(trayIcon)
	app.tray = tray

	err := wails.Run(&options.App{
		Title:                    "巧记",
		Width:                    s.Window.Width,
		Height:                   s.Window.Height,
		MinWidth:                 900,
		MinHeight:                600,
		StartHidden:              startHidden,
		Frameless:                true,
		DisableResize:            false,
		BackgroundColour:         backgroundFor(s.Theme),
		WindowStartState:         startState(s),
		EnableDefaultContextMenu: false,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "qiaoji-8f2a4c1e",
			OnSecondInstanceLaunch: app.onSecondInstance,
		},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: http.HandlerFunc(app.serveVaultAsset),
		},
		Windows: &windows.Options{
			// Keep the Aero shadow and Windows 11 rounded corners on the
			// frameless window; without them it reads as a floating rectangle.
			DisableFramelessWindowDecorations: false,
			WebviewUserDataPath:               webviewDataPath(),
			Theme:                             themeFor(s.Theme),
			IsZoomControlEnabled:              true,
			// Turning off the GPU removes a whole Chromium process worth about
			// 80 MB, at the cost of software-rasterised scrolling.
			WebviewGpuIsDisabled: !s.HardwareAcceleration,
			// Trackpad pinch is almost always accidental while writing.
			DisablePinchZoom: true,
			// Coalesce webview redraws while dragging the window edge.
			ResizeDebounceMS:    16,
			EnableSwipeGestures: false,
		},
		OnStartup: func(ctx context.Context) {
			app.startup(ctx)
			app.restoreWindowPosition(ctx)
			tray.start(ctx, app)
		},
		OnBeforeClose: app.onBeforeClose,
		OnShutdown: func(ctx context.Context) {
			tray.stop()
			app.shutdown(ctx)
		},
		Bind: []interface{}{app},
	})
	if err != nil {
		println("巧记 failed to start:", err.Error())
		os.Exit(1)
	}
}

func hasFlag(name string) bool {
	for _, a := range os.Args[1:] {
		if a == name {
			return true
		}
	}
	return false
}

func startState(s config.Settings) options.WindowStartState {
	if s.Window.Maximised {
		return options.Maximised
	}
	return options.Normal
}

func backgroundFor(theme string) *options.RGBA {
	if theme == "dark" {
		return &options.RGBA{R: 0x1a, G: 0x1d, B: 0x21, A: 1}
	}
	return &options.RGBA{R: 0xf0, G: 0xf1, B: 0xf2, A: 1}
}

func themeFor(theme string) windows.Theme {
	switch theme {
	case "dark":
		return windows.Dark
	case "light":
		return windows.Light
	default:
		return windows.SystemDefault
	}
}

// webviewDataPath keeps the WebView2 profile next to our settings instead of
// scattering it into the executable's directory.
func webviewDataPath() string {
	dir := config.Dir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	return dir
}

// onSecondInstance brings the existing window forward instead of starting a
// duplicate app, which also protects the vault from two writers.
func (a *App) onSecondInstance(options.SecondInstanceData) {
	if a.ctx == nil {
		return
	}
	wruntime.WindowUnminimise(a.ctx)
	wruntime.WindowShow(a.ctx)
	a.emit("window:focus", nil)
}

// closeFlushTimeout bounds how long the window stays open waiting for the
// frontend to answer. A wedged WebView must not leave a window that refuses to
// close; anything short of that is a normal flush and finishes far sooner.
const closeFlushTimeout = 8 * time.Second

// onBeforeClose runs for every exit path, including runtime.Quit.
//
// It is a two-step handshake. The first attempt is vetoed and the frontend is
// asked to flush; ConfirmClose comes back once every buffer is on disk and
// releases the veto. Returning false immediately, as this used to, let the
// process exit while the asynchronous flush was still in flight.
func (a *App) onBeforeClose(ctx context.Context) bool {
	a.persistWindow(ctx)

	// Closing the window is not quitting when the tray is holding the app.
	// A quit asked for explicitly (tray menu) sets quitRequested and skips it,
	// because the tray is the only way back from a hidden window.
	if !a.quitRequested.Load() && a.settings.Get().CloseToTray && a.tray.Available() {
		a.emit("app:before-close", map[string]any{"quitting": false})
		wruntime.WindowHide(ctx)
		return true
	}

	a.closeMu.Lock()
	switch a.closePhase {
	case closeConfirmed:
		a.closeMu.Unlock()
		return false
	case closeFlushing:
		// A second click while the first flush is still running.
		a.closeMu.Unlock()
		return true
	}
	done := make(chan struct{})
	a.closePhase, a.closeDone = closeFlushing, done
	a.closeMu.Unlock()

	a.emit("app:before-close", map[string]any{"quitting": true})
	go a.forceCloseAfter(done, closeFlushTimeout)
	return true
}

// forceCloseAfter releases the veto if the frontend never answers.
func (a *App) forceCloseAfter(done <-chan struct{}, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
		if a.ctx != nil {
			wruntime.LogWarning(a.ctx, "close flush timed out; quitting anyway")
		}
		a.ConfirmClose()
	}
}

// ConfirmClose is the frontend's half of the close handshake: every dirty
// buffer has been written and the window may go.
func (a *App) ConfirmClose() {
	a.closeMu.Lock()
	if a.closePhase == closeConfirmed {
		a.closeMu.Unlock()
		return
	}
	a.closePhase = closeConfirmed
	a.releaseCloseWaiterLocked()
	a.closeMu.Unlock()

	a.quitRequested.Store(true)
	if a.ctx != nil {
		wruntime.Quit(a.ctx)
	}
}

// CancelClose keeps the window open because a buffer could not be written.
// Quitting anyway would discard the edit with nowhere to recover it from.
func (a *App) CancelClose() {
	a.closeMu.Lock()
	if a.closePhase == closeConfirmed {
		a.closeMu.Unlock()
		return
	}
	a.closePhase = closeIdle
	a.releaseCloseWaiterLocked()
	a.closeMu.Unlock()

	a.quitRequested.Store(false)
	// The quit may have come from the tray with the window already hidden.
	// Refusing to exit behind a hidden window would look like nothing
	// happened, so the window comes back with the error on it.
	a.ShowWindow()
}

// ShowWindow brings the window forward, used when something needs attention
// after the app was sent to the tray.
func (a *App) ShowWindow() {
	if a.ctx == nil {
		return
	}
	showWindow(a.ctx)
}

func (a *App) releaseCloseWaiterLocked() {
	if a.closeDone != nil {
		close(a.closeDone)
		a.closeDone = nil
	}
}

// RequestQuit exits for real, ignoring the close-to-tray preference. The tray
// menu is the only way back from a hidden window, so its quit cannot hide.
func (a *App) RequestQuit() {
	if a.ctx == nil {
		return
	}
	a.quitRequested.Store(true)
	wruntime.Quit(a.ctx)
}

// restoreWindowPosition puts the window back where it was, but only if that
// spot is still on a connected monitor. Wails has no start-position option, so
// this runs right after startup.
func (a *App) restoreWindowPosition(ctx context.Context) {
	w := a.settings.Get().Window
	if w.Maximised || w.X < 0 || w.Y < 0 {
		wruntime.WindowCenter(ctx)
		return
	}
	if !positionIsVisible(w.X, w.Y, w.Width, w.Height) {
		wruntime.WindowCenter(ctx)
		return
	}
	wruntime.WindowSetPosition(ctx, w.X, w.Y)
}

func (a *App) persistWindow(ctx context.Context) {
	w, h := wruntime.WindowGetSize(ctx)
	x, y := wruntime.WindowGetPosition(ctx)
	a.settings.SetWindow(config.WindowState{
		Width: w, Height: h, X: x, Y: y,
		Maximised: wruntime.WindowIsMaximised(ctx),
	})
}

// ---------------------------------------------------------------- window API

func (a *App) WindowMinimise() {
	if a.ctx == nil {
		return
	}
	// Only vanish into the tray when there is a tray icon to come back from.
	if a.settings.Get().MinimiseToTray && a.tray.Available() {
		wruntime.WindowHide(a.ctx)
		return
	}
	wruntime.WindowMinimise(a.ctx)
}

func (a *App) WindowToggleMaximise() bool {
	if a.ctx == nil {
		return false
	}
	if wruntime.WindowIsMaximised(a.ctx) {
		wruntime.WindowUnmaximise(a.ctx)
		return false
	}
	wruntime.WindowMaximise(a.ctx)
	return true
}

func (a *App) WindowIsMaximised() bool {
	if a.ctx == nil {
		return false
	}
	return wruntime.WindowIsMaximised(a.ctx)
}

// WindowClose is the title-bar close button, so it honours the close-to-tray
// preference. RequestQuit is the one that always exits.
func (a *App) WindowClose() {
	if a.ctx == nil {
		return
	}
	wruntime.Quit(a.ctx)
}

// ApplyTheme keeps the native window chrome in step with the in-app theme, so
// the resize border and snap preview are not stuck in light mode.
func (a *App) ApplyTheme(theme string) {
	if a.ctx == nil {
		return
	}
	switch theme {
	case "dark":
		wruntime.WindowSetDarkTheme(a.ctx)
		wruntime.WindowSetBackgroundColour(a.ctx, 0x1a, 0x1d, 0x21, 255)
	case "light":
		wruntime.WindowSetLightTheme(a.ctx)
		wruntime.WindowSetBackgroundColour(a.ctx, 0xf0, 0xf1, 0xf2, 255)
	default:
		wruntime.WindowSetSystemDefaultTheme(a.ctx)
	}
}
