package main

import (
	"context"
	"embed"
	"os"

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
		AssetServer: &assetserver.Options{Assets: assets},
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

// onBeforeClose gives the frontend a chance to flush unsaved edits, and honours
// the "close to tray" preference.
func (a *App) onBeforeClose(ctx context.Context) bool {
	a.emit("app:before-close", nil)

	if a.settings.Get().CloseToTray && a.tray.Available() {
		wruntime.WindowHide(ctx)
		return true // veto the close; the tray keeps the app reachable
	}
	a.persistWindow(ctx)
	return false
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
