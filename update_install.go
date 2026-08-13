package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"qiaoji/internal/config"
)

const (
	maxInstallerBytes = 80 << 20
	installerFileName = "Qiaoji-%s-windows-amd64-setup.exe"
)

var (
	applyingUpdate atomic.Bool
	downloadClient = &http.Client{Timeout: 8 * time.Minute}
)

// ApplyUpdate downloads the latest installer, checks its SHA-256, then quits
// so a detached helper can run a silent overlay install and relaunch.
func (a *App) ApplyUpdate() error {
	if !applyingUpdate.CompareAndSwap(false, true) {
		return errors.New("正在更新，请稍候")
	}
	defer applyingUpdate.Store(false)

	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}

	a.emitProgress("check", 0, 0)
	info, err := fetchLatestVersion(ctx, updateClient, config.AppVersion, versionEndpoints...)
	if err != nil {
		return err
	}
	if !info.Available {
		return errors.New("当前已是最新版本")
	}

	sum := info.SHA256
	if sum == "" {
		a.emitProgress("check", 0, 0)
		sum, err = fetchReleaseChecksum(ctx, updateClient, info.LatestVersion, config.AppVersion)
		if err != nil {
			return err
		}
	}

	urls := installerEndpoints(info.LatestVersion, info.InstallerURL)
	a.emitProgress("download", 0, 0)
	installer, err := downloadInstaller(ctx, downloadClient, urls, sum, config.AppVersion, func(received, total int64) {
		a.emitProgress("download", received, total)
	})
	if err != nil {
		return err
	}

	a.emitProgress("verify", 1, 1)
	destDir, exeName, err := installTarget()
	if err != nil {
		_ = os.Remove(installer)
		return err
	}
	if err := launchInstallerAfterExit(os.Getpid(), installer, destDir, exeName); err != nil {
		_ = os.Remove(installer)
		return err
	}
	a.emitProgress("install", 1, 1)
	a.RequestQuit()
	return nil
}

func (a *App) emitProgress(stage string, received, total int64) {
	percent := 0
	if total > 0 {
		percent = int(received * 100 / total)
		if percent > 100 {
			percent = 100
		}
	}
	a.emit("update:progress", map[string]any{
		"stage":    stage,
		"percent":  percent,
		"received": received,
		"total":    total,
	})
}

func installerEndpoints(version, explicit string) []string {
	github := defaultInstallerURL(version)
	out := make([]string, 0, 2)
	if explicit != "" && allowedInstallerURL(explicit) && explicit != github {
		out = append(out, explicit)
	}
	out = append(out, github)
	return out
}

func allowedInstallerURL(raw string) bool {
	if raw == "" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Scheme != "https" {
		return false
	}
	if !strings.EqualFold(path.Ext(u.Path), ".exe") {
		return false
	}
	host := strings.ToLower(u.Host)
	path := strings.ToLower(u.Path)
	repo := strings.ToLower(repoOwner + "/" + repoName)
	switch host {
	case "github.com":
		return strings.HasPrefix(u.Path, "/"+repoOwner+"/"+repoName+"/releases/download/")
	case "cdn.jsdmirror.com", "cdn.jsdmirror.cn", "cdn.jsdelivr.net", "fastly.jsdelivr.net", "gcore.jsdelivr.net":
		return strings.Contains(path, repo)
	default:
		return false
	}
}

func looksLikeSHA256(sum string) bool {
	if len(sum) != 64 {
		return false
	}
	for _, c := range sum {
		if c >= '0' && c <= '9' || c >= 'a' && c <= 'f' {
			continue
		}
		return false
	}
	return true
}

func fetchReleaseChecksum(ctx context.Context, client *http.Client, version, current string) (string, error) {
	name := fmt.Sprintf(installerFileName, version)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, defaultChecksumURL(version), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "Qiaoji/"+current)
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("无法获取安装包校验值")
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return "", errors.New("无法读取安装包校验值")
	}
	if response.StatusCode != http.StatusOK {
		return "", errors.New("无法获取安装包校验值")
	}
	sum := checksumForFile(body, name)
	if sum == "" {
		return "", errors.New("安装包校验信息不完整")
	}
	return sum, nil
}

func checksumForFile(body []byte, name string) string {
	want := strings.ToLower(name)
	for _, line := range strings.Split(string(body), "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		file := strings.TrimPrefix(fields[len(fields)-1], "*")
		if !strings.EqualFold(file, want) {
			continue
		}
		sum := strings.ToLower(fields[0])
		if looksLikeSHA256(sum) {
			return sum
		}
	}
	return ""
}

func downloadInstaller(
	ctx context.Context,
	client *http.Client,
	urls []string,
	wantSHA string,
	current string,
	progress func(received, total int64),
) (string, error) {
	if !looksLikeSHA256(wantSHA) {
		return "", errors.New("安装包校验值无效")
	}
	var lastErr error
	for _, endpoint := range urls {
		path, err := downloadInstallerOnce(ctx, client, endpoint, wantSHA, current, progress)
		if err != nil {
			lastErr = err
			continue
		}
		return path, nil
	}
	if lastErr == nil {
		lastErr = errors.New("无法下载安装包")
	}
	return "", lastErr
}

func downloadInstallerOnce(
	ctx context.Context,
	client *http.Client,
	endpoint, wantSHA, current string,
	progress func(received, total int64),
) (string, error) {
	if !allowedInstallerURL(endpoint) {
		return "", errors.New("安装包地址无效")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "Qiaoji/"+current)
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("无法下载安装包")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", errors.New("无法下载安装包")
	}
	if response.ContentLength > maxInstallerBytes {
		return "", errors.New("安装包过大")
	}
	return saveInstallerPayload(response.Body, response.ContentLength, wantSHA, progress)
}

func saveInstallerPayload(body io.Reader, contentLength int64, wantSHA string, progress func(received, total int64)) (string, error) {
	if contentLength > maxInstallerBytes {
		return "", errors.New("安装包过大")
	}

	tmp, err := os.CreateTemp("", "qiaoji-update-*.exe")
	if err != nil {
		return "", errors.New("无法保存安装包")
	}
	path := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()

	hash := sha256.New()
	reader := io.LimitReader(body, maxInstallerBytes+1)
	buf := make([]byte, 32*1024)
	var written int64
	var header [2]byte
	headerFilled := 0
	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if headerFilled < 2 {
				copied := copy(header[headerFilled:], chunk)
				headerFilled += copied
				if headerFilled >= 2 && string(header[:]) != "MZ" {
					return "", errors.New("安装包格式无效")
				}
			}
			if _, err := hash.Write(chunk); err != nil {
				return "", errors.New("无法校验安装包")
			}
			if _, err := tmp.Write(chunk); err != nil {
				return "", errors.New("无法保存安装包")
			}
			written += int64(n)
			if written > maxInstallerBytes {
				return "", errors.New("安装包过大")
			}
			if progress != nil {
				progress(written, contentLength)
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", errors.New("下载安装包中断")
		}
	}
	if headerFilled < 2 || string(header[:]) != "MZ" {
		return "", errors.New("安装包格式无效")
	}
	got := hex.EncodeToString(hash.Sum(nil))
	if got != wantSHA {
		return "", errors.New("安装包校验失败，已取消安装")
	}
	if err := tmp.Close(); err != nil {
		return "", errors.New("无法保存安装包")
	}
	ok = true
	return path, nil
}

func installTarget() (dir, exeName string, err error) {
	self, err := os.Executable()
	if err != nil {
		return "", "", errors.New("无法确定安装目录")
	}
	if resolved, rerr := filepath.EvalSymlinks(self); rerr == nil {
		self = resolved
	}
	dir = strings.TrimRight(filepath.Clean(filepath.Dir(self)), `\/`)
	exeName = filepath.Base(self)
	if dir == "" || exeName == "" {
		return "", "", errors.New("无法确定安装目录")
	}
	return dir, exeName, nil
}
