//go:build !windows

package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
)

func revealInFileManager(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-R", abs).Start()
	}
	return exec.Command("xdg-open", filepath.Dir(abs)).Start()
}

func openWithDefaultApp(path string) error {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", path).Start()
	}
	return exec.Command("xdg-open", path).Start()
}
