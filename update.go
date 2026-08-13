package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"qiaoji/internal/config"
)

const (
	repoOwner = "7788dev"
	repoName  = "qiaoji"
	repoURL   = "https://github.com/" + repoOwner + "/" + repoName
	// versionCDNPath is served by jsDelivr-compatible CDNs. JSDMirror sits on
	// Alibaba / Tencent / Huawei / Baidu, which is more stable in China than
	// volunteer GitHub reverse proxies.
	versionCDNPath = "gh/" + repoOwner + "/" + repoName + "@main/version.json"
)

var versionEndpoints = []string{
	"https://cdn.jsdmirror.com/" + versionCDNPath,
	"https://cdn.jsdmirror.cn/" + versionCDNPath,
	"https://gcore.jsdelivr.net/" + versionCDNPath,
	"https://fastly.jsdelivr.net/" + versionCDNPath,
	"https://cdn.jsdelivr.net/" + versionCDNPath,
}

var updateClient = &http.Client{Timeout: 8 * time.Second}

type remoteVersion struct {
	Version   string
	Page      string
	Installer string
	SHA256    string
}

// UpdateInfo describes the latest published version. ApplyUpdate downloads the
// installer itself; the repository URL is only a manual fallback.
type UpdateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	Available      bool   `json:"available"`
	ReleaseURL     string `json:"releaseUrl"`
	InstallerURL   string `json:"installerUrl"`
	SHA256         string `json:"sha256"`
}

// CheckForUpdates reads version.json via a mainland CDN. Network failures are
// returned so automatic checks can stay quiet while a manual check can explain.
func (a *App) CheckForUpdates() (UpdateInfo, error) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return fetchLatestVersion(ctx, updateClient, config.AppVersion, versionEndpoints...)
}

func fetchLatestVersion(
	ctx context.Context,
	client *http.Client,
	current string,
	endpoints ...string,
) (UpdateInfo, error) {
	out := UpdateInfo{
		CurrentVersion: current,
		ReleaseURL:     repoURL,
	}
	if len(endpoints) == 0 {
		endpoints = versionEndpoints
	}

	var lastErr error
	for _, endpoint := range endpoints {
		remote, err := fetchVersionFile(ctx, client, endpoint, current)
		if err != nil {
			lastErr = err
			continue
		}
		return fillUpdateInfo(current, remote), nil
	}
	if lastErr == nil {
		lastErr = errors.New("无法检查更新")
	}
	return out, lastErr
}

func fillUpdateInfo(current string, remote remoteVersion) UpdateInfo {
	out := UpdateInfo{
		CurrentVersion: current,
		ReleaseURL:     repoURL,
	}
	latest, ok := parseReleaseVersion(remote.Version)
	if !ok {
		return out
	}
	out.LatestVersion = strings.TrimPrefix(strings.TrimPrefix(remote.Version, "v"), "V")
	if allowedReleaseURL(remote.Page) {
		out.ReleaseURL = remote.Page
	}
	out.InstallerURL = defaultInstallerURL(out.LatestVersion)
	if allowedInstallerURL(remote.Installer) {
		out.InstallerURL = remote.Installer
	}
	if sum := strings.ToLower(strings.TrimSpace(remote.SHA256)); looksLikeSHA256(sum) {
		out.SHA256 = sum
	}
	if installed, ok := parseReleaseVersion(current); ok {
		out.Available = compareReleaseVersion(latest, installed) > 0
	}
	return out
}

func fetchVersionFile(ctx context.Context, client *http.Client, endpoint, current string) (remoteVersion, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return remoteVersion{}, err
	}
	request.Header.Set("Accept", "application/json, text/plain;q=0.9, */*;q=0.8")
	request.Header.Set("Cache-Control", "no-cache")
	request.Header.Set("User-Agent", "Qiaoji/"+current)

	response, err := client.Do(request)
	if err != nil {
		return remoteVersion{}, errors.New("无法获取版本信息")
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<16))
	if err != nil {
		return remoteVersion{}, errors.New("无法读取版本信息")
	}
	if response.StatusCode != http.StatusOK {
		return remoteVersion{}, versionStatusError(response.StatusCode)
	}

	remote, ok := parseVersionPayload(body)
	if !ok {
		return remoteVersion{}, errors.New("版本信息格式无效")
	}
	return remote, nil
}

func parseVersionPayload(body []byte) (remoteVersion, bool) {
	trimmed := strings.TrimSpace(string(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))))
	if trimmed == "" {
		return remoteVersion{}, false
	}

	var file struct {
		Version   string `json:"version"`
		URL       string `json:"url"`
		Installer string `json:"installer"`
		SHA256    string `json:"sha256"`
	}
	if json.Unmarshal([]byte(trimmed), &file) == nil && strings.TrimSpace(file.Version) != "" {
		if _, ok := parseReleaseVersion(file.Version); !ok {
			return remoteVersion{}, false
		}
		return remoteVersion{
			Version:   strings.TrimSpace(file.Version),
			Page:      strings.TrimSpace(file.URL),
			Installer: strings.TrimSpace(file.Installer),
			SHA256:    strings.TrimSpace(file.SHA256),
		}, true
	}
	if _, ok := parseReleaseVersion(trimmed); !ok {
		return remoteVersion{}, false
	}
	return remoteVersion{Version: trimmed}, true
}

func defaultInstallerURL(version string) string {
	return fmt.Sprintf(
		"https://github.com/%s/%s/releases/download/v%s/Qiaoji-%s-windows-amd64-setup.exe",
		repoOwner,
		repoName,
		version,
		version,
	)
}

func defaultChecksumURL(version string) string {
	return fmt.Sprintf(
		"https://github.com/%s/%s/releases/download/v%s/SHA256SUMS.txt",
		repoOwner,
		repoName,
		version,
	)
}

func allowedReleaseURL(raw string) bool {
	if raw == "" {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || u.Scheme != "https" || u.Host != "github.com" {
		return false
	}
	path := strings.TrimSuffix(u.Path, "/")
	prefix := "/" + repoOwner + "/" + repoName
	return path == prefix || strings.HasPrefix(path+"/", prefix+"/")
}

func versionStatusError(code int) error {
	switch code {
	case http.StatusNotFound:
		return errors.New("未找到版本信息")
	default:
		return errors.New("暂时无法获取版本信息，请稍后重试")
	}
}

type releaseVersion struct {
	major, minor, patch int
	prerelease          bool
}

func parseReleaseVersion(raw string) (releaseVersion, bool) {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(strings.TrimPrefix(value, "v"), "V")
	value = strings.SplitN(value, "+", 2)[0]
	coreAndPre := strings.SplitN(value, "-", 2)
	if len(coreAndPre) == 2 && coreAndPre[1] == "" {
		return releaseVersion{}, false
	}
	parts := strings.Split(coreAndPre[0], ".")
	if len(parts) != 3 {
		return releaseVersion{}, false
	}

	numbers := [3]int{}
	for i, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return releaseVersion{}, false
		}
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return releaseVersion{}, false
		}
		numbers[i] = number
	}
	return releaseVersion{
		major:      numbers[0],
		minor:      numbers[1],
		patch:      numbers[2],
		prerelease: len(coreAndPre) == 2 && coreAndPre[1] != "",
	}, true
}

func compareReleaseVersion(left, right releaseVersion) int {
	for _, pair := range [][2]int{
		{left.major, right.major},
		{left.minor, right.minor},
		{left.patch, right.patch},
	} {
		if pair[0] < pair[1] {
			return -1
		}
		if pair[0] > pair[1] {
			return 1
		}
	}
	if left.prerelease == right.prerelease {
		return 0
	}
	if left.prerelease {
		return -1
	}
	return 1
}
