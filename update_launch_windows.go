//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

func launchInstallerAfterExit(pid int, installer, destDir, exeName string) error {
	script := filepath.Join(os.TempDir(), fmt.Sprintf("qiaoji-apply-update-%d.ps1", pid))
	body := fmt.Sprintf(`$ErrorActionPreference = 'Continue'
$pidToWait = %d
$setup = %s
$dir = %s
$exe = Join-Path $dir %s
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 400
}
if (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) {
  Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
  exit 1
}
cmd.exe /C ('"{0}" /S /D={1}' -f $setup, $dir) | Out-Null
if (Test-Path -LiteralPath $exe) {
  Start-Process -FilePath $exe
}
Remove-Item -LiteralPath $setup -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`, pid, psQuote(installer), psQuote(destDir), psQuote(exeName))

	if err := os.WriteFile(script, append([]byte{0xEF, 0xBB, 0xBF}, []byte(body)...), 0o700); err != nil {
		return errors.New("无法准备安装脚本")
	}

	cmd := exec.Command("cmd.exe", "/C", "start", "", "/MIN", "powershell.exe",
		"-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		_ = os.Remove(script)
		return errors.New("无法启动安装程序")
	}
	return nil
}

func psQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}
