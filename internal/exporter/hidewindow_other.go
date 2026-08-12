//go:build !windows

package exporter

import "os/exec"

func hideWindow(*exec.Cmd) {}
