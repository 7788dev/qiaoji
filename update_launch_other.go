//go:build !windows

package main

import "errors"

func launchInstallerAfterExit(int, string, string, string) error {
	return errors.New("当前系统不支持应用内更新")
}
