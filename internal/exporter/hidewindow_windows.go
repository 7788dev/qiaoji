//go:build windows

package exporter

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the headless browser from flashing a console window during
// export.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
