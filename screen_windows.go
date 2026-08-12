//go:build windows

package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32              = windows.NewLazySystemDLL("user32.dll")
	procMonitorFromRect = user32.NewProc("MonitorFromRect")
)

// MONITOR_DEFAULTTONULL: return NULL when the rectangle touches no monitor.
const monitorDefaultToNull = 0

type rect struct{ left, top, right, bottom int32 }

// positionIsVisible reports whether a saved window rectangle still intersects a
// connected monitor. Restoring onto a display that has since been unplugged
// would strand the window off-screen with no way to drag it back.
func positionIsVisible(x, y, w, h int) bool {
	if w <= 0 || h <= 0 {
		return false
	}
	r := rect{
		left:   int32(x),
		top:    int32(y),
		right:  int32(x + w),
		bottom: int32(y + h),
	}
	handle, _, _ := procMonitorFromRect.Call(
		uintptr(unsafe.Pointer(&r)),
		uintptr(monitorDefaultToNull),
	)
	return handle != 0
}
