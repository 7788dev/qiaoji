//go:build windows

package main

import (
	"os/exec"
	"path/filepath"
	"syscall"
)

const noWindow = 0x08000000

// revealInFileManager opens Explorer with the file already selected.
func revealInFileManager(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	cmd := exec.Command("explorer.exe", "/select,"+abs)
	// explorer.exe returns 1 even on success, so its exit code is not a signal.
	_ = cmd.Start()
	return nil
}

func openWithDefaultApp(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	cmd := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", abs)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: noWindow}
	return cmd.Start()
}
