package main

import (
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
	latestReleaseAPI = "https://api.github.com/repos/7788dev/qiaoji/releases/latest"
	releasesBaseURL  = "https://github.com/7788dev/qiaoji/releases/tag/"
)

var updateClient = &http.Client{Timeout: 10 * time.Second}

// UpdateInfo describes the latest stable GitHub release. The app deliberately
// opens the release page instead of downloading or executing code itself.
type UpdateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	Available      bool   `json:"available"`
	ReleaseURL     string `json:"releaseUrl"`
}

// CheckForUpdates queries GitHub's latest stable release endpoint. Network
// failures are returned to the caller so automatic checks can stay quiet while
// manual checks can give the user an actionable error.
func (a *App) CheckForUpdates() (UpdateInfo, error) {
	ctx := a.ctx
	if ctx == nil {
		ctx = context.Background()
	}
	return fetchLatestRelease(ctx, updateClient, latestReleaseAPI, config.AppVersion)
}

func fetchLatestRelease(
	ctx context.Context,
	client *http.Client,
	endpoint string,
	current string,
) (UpdateInfo, error) {
	out := UpdateInfo{CurrentVersion: current}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return out, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "Qiaoji/"+current)

	response, err := client.Do(request)
	if err != nil {
		return out, fmt.Errorf("无法连接 GitHub: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return out, fmt.Errorf("GitHub 返回状态 %d", response.StatusCode)
	}

	var release struct {
		TagName string `json:"tag_name"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(&release); err != nil {
		return out, fmt.Errorf("更新信息格式无效: %w", err)
	}

	latest, ok := parseReleaseVersion(release.TagName)
	if !ok {
		return out, errors.New("GitHub Release 标签不是有效版本号")
	}
	out.LatestVersion = strings.TrimPrefix(strings.TrimPrefix(release.TagName, "v"), "V")
	out.ReleaseURL = releasesBaseURL + url.PathEscape(release.TagName)
	if installed, ok := parseReleaseVersion(current); ok {
		out.Available = compareReleaseVersion(latest, installed) > 0
	}
	return out, nil
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
