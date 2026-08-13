//go:build windows

package exporter

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/go-webview2/pkg/edge"
	"golang.org/x/sys/windows"
)

func init() {
	htmlToPDF = printHTMLToPDFWebView2
}

const (
	wsPopup          = 0x80000000
	wsExNoActivate   = 0x08000000
	wsExToolwindow   = 0x00000080
	pmRemove         = 0x0001
	qsAllInput       = 0x04FF
	wmQuit           = 0x0012
	errorClassExists = 1410

	// COM vtable slots. go-webview2's generated ICoreWebView2_7 / Environment6
	// bindings omit parent methods, so those wrappers hit the wrong slot.
	vtblRelease              = 2
	vtblCreatePrintSettings  = 14
	vtblPutPrintBackgrounds  = 20
	vtblControllerClose      = 24
	vtblPutPrintHeaderFooter = 24
	vtblPrintToPdf           = 80
)

var (
	iidWebView2_7 = windows.GUID{
		Data1: 0x79c24d83,
		Data2: 0x09a3,
		Data3: 0x45ae,
		Data4: [8]byte{0x94, 0x18, 0x48, 0x7f, 0x32, 0xa5, 0x87, 0x40},
	}
	iidEnvironment6 = windows.GUID{
		Data1: 0xe59ee362,
		Data2: 0xacbd,
		Data3: 0x4857,
		Data4: [8]byte{0x9a, 0x8e, 0xd3, 0x64, 0x4d, 0x94, 0x59, 0xa9},
	}

	user32               = windows.NewLazySystemDLL("user32.dll")
	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procShowWindow       = user32.NewProc("ShowWindow")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procPeekMessageW     = user32.NewProc("PeekMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procMsgWait          = user32.NewProc("MsgWaitForMultipleObjects")
	procPostThreadMsg    = user32.NewProc("PostThreadMessageW")

	cbPrintQI      = windows.NewCallback(printHandlerQI)
	cbPrintAddRef  = windows.NewCallback(printHandlerAddRef)
	cbPrintRelease = windows.NewCallback(printHandlerRelease)
	cbPrintInvoke  = windows.NewCallback(printHandlerInvoke)

	printHandlerVtbl = printToPdfHandlerVtbl{
		queryInterface: cbPrintQI,
		addRef:         cbPrintAddRef,
		release:        cbPrintRelease,
		invoke:         cbPrintInvoke,
	}

	pdfClassOnce sync.Once
	pdfClassErr  error
	pdfClassAtom uintptr
	pdfWndProc   uintptr
	pdfClassName *uint16

	webviewPrintMu sync.Mutex
)

type winMsg struct {
	hwnd     uintptr
	message  uint32
	wParam   uintptr
	lParam   uintptr
	time     uint32
	ptX, ptY int32
	lPrivate uint32
}

type wndClassExW struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     windows.Handle
	hIcon         windows.Handle
	hCursor       windows.Handle
	hbrBackground windows.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       windows.Handle
}

type printToPdfHandlerVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	invoke         uintptr
}

type printToPdfHandler struct {
	vtbl *printToPdfHandlerVtbl
	done chan error
}

func printHandlerQI(_, _, _ uintptr) uintptr { return 0 }
func printHandlerAddRef(_ uintptr) uintptr   { return 1 }
func printHandlerRelease(_ uintptr) uintptr  { return 1 }

func printHandlerInvoke(this, errorCode, result uintptr) uintptr {
	h := (*printToPdfHandler)(unsafe.Pointer(this))
	var err error
	if errorCode != 0 {
		err = windows.Errno(errorCode)
	} else if result == 0 {
		err = errors.New("PrintToPdf 未成功")
	}
	select {
	case h.done <- err:
	default:
	}
	return 0
}

func pdfDefWindowProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	r, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return r
}

func registerPDFClass() error {
	pdfClassOnce.Do(func() {
		pdfWndProc = windows.NewCallback(pdfDefWindowProc)
		name, err := windows.UTF16PtrFromString("QiaojiPdfHost")
		if err != nil {
			pdfClassErr = err
			return
		}
		pdfClassName = name

		var instance windows.Handle
		if err := windows.GetModuleHandleEx(0, nil, &instance); err != nil {
			pdfClassErr = err
			return
		}

		wc := wndClassExW{
			cbSize:        uint32(unsafe.Sizeof(wndClassExW{})),
			lpfnWndProc:   pdfWndProc,
			hInstance:     instance,
			lpszClassName: pdfClassName,
		}
		atom, _, callErr := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
		if atom == 0 {
			if errno, ok := callErr.(syscall.Errno); ok && errno == errorClassExists {
				pdfClassAtom = 1
				return
			}
			pdfClassErr = fmt.Errorf("RegisterClassEx: %v", callErr)
			return
		}
		pdfClassAtom = atom
	})
	return pdfClassErr
}

func printHTMLToPDFWebView2(srcHTML, dstPDF string) error {
	webviewPrintMu.Lock()
	defer webviewPrintMu.Unlock()

	dataDir, err := os.MkdirTemp("", "qiaoji-wvpdf-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dataDir)

	srcAbs, err := filepath.Abs(srcHTML)
	if err != nil {
		return err
	}
	dstAbs, err := filepath.Abs(dstPDF)
	if err != nil {
		return err
	}

	return runOnSTA(90*time.Second, func() error {
		return printWithWebView2STA(srcAbs, dstAbs, dataDir)
	})
}

func runOnSTA(timeout time.Duration, fn func() error) error {
	done := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer func() {
			if v := recover(); v != nil {
				done <- fmt.Errorf("%v", v)
			}
		}()
		done <- fn()
	}()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		return errors.New("应用内 PDF 引擎超时")
	}
}

func printWithWebView2STA(srcHTML, dstPDF, dataDir string) error {
	err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED)
	if hr, ok := err.(windows.Errno); ok && int32(hr) < 0 {
		return fmt.Errorf("COM 初始化失败: 0x%08x", uint32(hr))
	}
	defer windows.CoUninitialize()

	if err := registerPDFClass(); err != nil {
		return err
	}

	var instance windows.Handle
	if err := windows.GetModuleHandleEx(0, nil, &instance); err != nil {
		return err
	}
	title, _ := windows.UTF16PtrFromString("巧记 PDF")
	off := int32(-32000)
	hwnd, _, _ := procCreateWindowExW.Call(
		wsExNoActivate|wsExToolwindow,
		uintptr(unsafe.Pointer(pdfClassName)),
		uintptr(unsafe.Pointer(title)),
		wsPopup,
		uintptr(off),
		uintptr(off),
		800,
		1200,
		0, 0,
		uintptr(instance),
		0,
	)
	if hwnd == 0 {
		return errors.New("无法创建 PDF 预览窗口")
	}
	defer procDestroyWindow.Call(hwnd)

	chromium := edge.NewChromium()
	chromium.DataPath = dataDir
	// Default callback calls os.Exit(1). Panic instead; runOnSTA recovers.
	chromium.SetErrorCallback(func(err error) {
		panic(err)
	})

	tid := windows.GetCurrentThreadId()
	stopWatch := make(chan struct{})
	var watchOnce sync.Once
	go func() {
		select {
		case <-time.After(45 * time.Second):
			procPostThreadMsg.Call(uintptr(tid), wmQuit, 0, 0)
		case <-stopWatch:
		}
	}()
	defer watchOnce.Do(func() { close(stopWatch) })

	if !chromium.Embed(hwnd) {
		return errors.New("WebView2 初始化失败")
	}
	watchOnce.Do(func() { close(stopWatch) })

	controller := chromium.GetController()
	if controller == nil {
		return errors.New("WebView2 初始化失败")
	}
	defer closeController(controller)

	_ = controller.PutBounds(edge.Rect{Right: 794, Bottom: 1123})
	_ = controller.PutIsVisible(true)
	procShowWindow.Call(hwnd, windows.SW_SHOWNOACTIVATE)

	navDone := make(chan struct{})
	chromium.NavigationCompletedCallback = func(*edge.ICoreWebView2, *edge.ICoreWebView2NavigationCompletedEventArgs) {
		select {
		case <-navDone:
		default:
			close(navDone)
		}
	}

	wv, err := controller.GetCoreWebView2()
	if err != nil {
		return err
	}
	if err := wv.Navigate(fileURL(srcHTML)); err != nil {
		return err
	}
	if err := pumpUntil(navDone, 30*time.Second); err != nil {
		return fmt.Errorf("页面加载失败: %w", err)
	}

	// data: fonts in the standalone HTML usually apply during parse; a short
	// extra pump lets the compositor settle before PrintToPdf snapshots.
	settle := make(chan struct{})
	time.AfterFunc(400*time.Millisecond, func() { close(settle) })
	_ = pumpUntil(settle, 2*time.Second)

	settings := createPrintSettings(chromium.Environment())
	if settings != nil {
		defer releaseCOM(settings)
		callVtbl(settings, vtblPutPrintBackgrounds, 1)
		callVtbl(settings, vtblPutPrintHeaderFooter, 0)
	}

	printed := make(chan error, 1)
	handler := &printToPdfHandler{vtbl: &printHandlerVtbl, done: printed}

	wv7, err := queryInterface(unsafe.Pointer(wv), &iidWebView2_7)
	if err != nil || wv7 == nil {
		return errors.New("当前 WebView2 运行时不支持导出 PDF")
	}

	var settingsPtr uintptr
	if settings != nil {
		settingsPtr = uintptr(settings)
	}
	if err := callPrintToPdf(wv7, dstPDF, settingsPtr, uintptr(unsafe.Pointer(handler))); err != nil {
		return err
	}

	printErr := pumpUntilChan(printed, 60*time.Second)
	runtime.KeepAlive(handler)
	runtime.KeepAlive(settings)
	if st, serr := os.Stat(dstPDF); serr == nil && st.Size() > 0 {
		return nil
	}
	if printErr != nil {
		return printErr
	}
	return errors.New("导出的 PDF 为空")
}

func pumpUntil(done <-chan struct{}, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var msg winMsg
	for {
		select {
		case <-done:
			return nil
		default:
		}
		if time.Now().After(deadline) {
			return errors.New("超时")
		}
		for {
			r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, pmRemove)
			if r == 0 {
				break
			}
			if msg.message == wmQuit {
				return errors.New("消息循环已退出")
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
			select {
			case <-done:
				return nil
			default:
			}
		}
		procMsgWait.Call(0, 0, 0, 50, qsAllInput)
	}
}

func pumpUntilChan(done <-chan error, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var msg winMsg
	for {
		select {
		case err := <-done:
			return err
		default:
		}
		if time.Now().After(deadline) {
			return errors.New("超时")
		}
		for {
			r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, pmRemove)
			if r == 0 {
				break
			}
			if msg.message == wmQuit {
				return errors.New("消息循环已退出")
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
			select {
			case err := <-done:
				return err
			default:
			}
		}
		procMsgWait.Call(0, 0, 0, 50, qsAllInput)
	}
}

type comObj struct {
	vtbl *[vtblPrintToPdf + 1]uintptr
}

func queryInterface(obj unsafe.Pointer, iid *windows.GUID) (unsafe.Pointer, error) {
	var out unsafe.Pointer
	o := (*comObj)(obj)
	hr, _, _ := syscall.SyscallN(o.vtbl[0], uintptr(obj), uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	if hr != 0 {
		return nil, windows.Errno(hr)
	}
	return out, nil
}

func callVtbl(obj unsafe.Pointer, slot int, arg uintptr) {
	o := (*comObj)(obj)
	_, _, _ = syscall.SyscallN(o.vtbl[slot], uintptr(obj), arg)
}

func releaseCOM(obj unsafe.Pointer) {
	o := (*comObj)(obj)
	_, _, _ = syscall.SyscallN(o.vtbl[vtblRelease], uintptr(obj))
}

func callPrintToPdf(wv7 unsafe.Pointer, path string, settings, handler uintptr) error {
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	o := (*comObj)(wv7)
	hr, _, _ := syscall.SyscallN(
		o.vtbl[vtblPrintToPdf],
		uintptr(wv7),
		uintptr(unsafe.Pointer(path16)),
		settings,
		handler,
	)
	if hr != 0 {
		return windows.Errno(hr)
	}
	return nil
}

func createPrintSettings(env *edge.ICoreWebView2Environment) unsafe.Pointer {
	if env == nil {
		return nil
	}
	env6, err := queryInterface(unsafe.Pointer(env), &iidEnvironment6)
	if err != nil || env6 == nil {
		return nil
	}
	var settings unsafe.Pointer
	o := (*comObj)(env6)
	hr, _, _ := syscall.SyscallN(o.vtbl[vtblCreatePrintSettings], uintptr(env6), uintptr(unsafe.Pointer(&settings)))
	if hr != 0 {
		return nil
	}
	return settings
}

func closeController(c *edge.ICoreWebView2Controller) {
	if c == nil {
		return
	}
	o := (*comObj)(unsafe.Pointer(c))
	_, _, _ = syscall.SyscallN(o.vtbl[vtblControllerClose], uintptr(unsafe.Pointer(c)))
}
