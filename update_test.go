package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestFetchLatestVersionFindsNewVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept"), "application/json") {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		if !strings.HasPrefix(r.Header.Get("User-Agent"), "Qiaoji/") {
			t.Errorf("User-Agent = %q", r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"version":"1.2.0","url":"https://github.com/7788dev/qiaoji"}`))
	}))
	defer server.Close()

	info, err := fetchLatestVersion(context.Background(), server.Client(), "1.1.9", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if !info.Available {
		t.Fatal("expected an available update")
	}
	if info.LatestVersion != "1.2.0" {
		t.Fatalf("LatestVersion = %q", info.LatestVersion)
	}
	if info.ReleaseURL != repoURL {
		t.Fatalf("ReleaseURL = %q", info.ReleaseURL)
	}
	if info.InstallerURL != defaultInstallerURL("1.2.0") {
		t.Fatalf("InstallerURL = %q", info.InstallerURL)
	}
}

func TestFetchLatestVersionHandlesCurrentAndDevelopmentBuilds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"1.0.0"}`))
	}))
	defer server.Close()

	for _, current := range []string{"1.0.0", "1.1.0", "dev"} {
		info, err := fetchLatestVersion(context.Background(), server.Client(), current, server.URL)
		if err != nil {
			t.Fatalf("%s: %v", current, err)
		}
		if info.Available {
			t.Errorf("%s unexpectedly reported an update", current)
		}
		if info.LatestVersion != "1.0.0" {
			t.Errorf("%s: LatestVersion = %q", current, info.LatestVersion)
		}
	}
}

func TestFetchLatestVersionRejectsBadResponses(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"status": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "forbidden", http.StatusForbidden)
		},
		"json": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`not json`))
		},
		"tag": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"version":"latest"}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(handler)
			defer server.Close()
			if _, err := fetchLatestVersion(
				context.Background(),
				server.Client(),
				"1.0.0",
				server.URL,
			); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestFetchLatestVersionFallsBackAfterForbidden(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"1.0.1"}`))
	}))
	defer ok.Close()
	blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer blocked.Close()

	info, err := fetchLatestVersion(context.Background(), ok.Client(), "1.0.0", blocked.URL, ok.URL)
	if err != nil {
		t.Fatal(err)
	}
	if info.LatestVersion != "1.0.1" {
		t.Fatalf("LatestVersion = %q", info.LatestVersion)
	}
	if !info.Available {
		t.Fatal("expected an available update")
	}
}

func TestFetchLatestVersionReadsPlainText(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("v1.2.3\n"))
	}))
	defer server.Close()

	info, err := fetchLatestVersion(context.Background(), server.Client(), "1.0.0", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if info.LatestVersion != "1.2.3" {
		t.Fatalf("LatestVersion = %q", info.LatestVersion)
	}
}

func TestFillUpdateInfoIgnoresDisallowedURL(t *testing.T) {
	info := fillUpdateInfo("1.0.0", remoteVersion{Version: "1.0.1", Page: "https://evil.example/update"})
	if info.ReleaseURL != repoURL {
		t.Fatalf("ReleaseURL = %q", info.ReleaseURL)
	}
	if !info.Available {
		t.Fatal("expected an available update")
	}
	if info.InstallerURL != defaultInstallerURL("1.0.1") {
		t.Fatalf("InstallerURL = %q", info.InstallerURL)
	}
}

func TestAllowedReleaseURL(t *testing.T) {
	allowed := []string{
		"https://github.com/7788dev/qiaoji",
		"https://github.com/7788dev/qiaoji/",
		"https://github.com/7788dev/qiaoji/releases/latest",
	}
	for _, raw := range allowed {
		if !allowedReleaseURL(raw) {
			t.Errorf("rejected %q", raw)
		}
	}
	blocked := []string{
		"",
		"http://github.com/7788dev/qiaoji",
		"https://github.com.evil/7788dev/qiaoji",
		"https://github.com/other/qiaoji",
		"https://user:pass@github.com/7788dev/qiaoji",
	}
	for _, raw := range blocked {
		if allowedReleaseURL(raw) {
			t.Errorf("allowed %q", raw)
		}
	}
}

func TestRepoVersionFile(t *testing.T) {
	body, err := os.ReadFile("version.json")
	if err != nil {
		t.Fatal(err)
	}
	remote, ok := parseVersionPayload(body)
	if !ok {
		t.Fatalf("could not parse version.json: %s", body)
	}
	if _, valid := parseReleaseVersion(remote.Version); !valid {
		t.Fatalf("invalid version %q", remote.Version)
	}
	if remote.Page != "" && !allowedReleaseURL(remote.Page) {
		t.Fatalf("url %q is not the project repository", remote.Page)
	}
	if remote.Installer != "" && !allowedInstallerURL(remote.Installer) {
		t.Fatalf("installer %q is not allowed", remote.Installer)
	}
	if remote.SHA256 != "" && !looksLikeSHA256(strings.ToLower(remote.SHA256)) {
		t.Fatalf("sha256 %q is invalid", remote.SHA256)
	}
}

func TestParseReleaseVersion(t *testing.T) {
	for _, test := range []struct {
		left, right string
		want        int
	}{
		{"1.0.1", "1.0.0", 1},
		{"v2.0.0", "1.99.99", 1},
		{"1.0.0-beta.1", "1.0.0", -1},
		{"1.0.0", "1.0.0", 0},
	} {
		left, ok := parseReleaseVersion(test.left)
		if !ok {
			t.Fatalf("could not parse %q", test.left)
		}
		right, ok := parseReleaseVersion(test.right)
		if !ok {
			t.Fatalf("could not parse %q", test.right)
		}
		if got := compareReleaseVersion(left, right); got != test.want {
			t.Errorf("compare(%q, %q) = %d, want %d", test.left, test.right, got, test.want)
		}
	}

	for _, invalid := range []string{"", "dev", "1", "1.2", "1.2.3.4", "1.02.3", "1.2.x"} {
		if _, ok := parseReleaseVersion(invalid); ok {
			t.Errorf("accepted invalid version %q", invalid)
		}
	}
}

func TestAllowedInstallerURL(t *testing.T) {
	allowed := []string{
		defaultInstallerURL("1.0.1"),
		"https://cdn.jsdmirror.com/gh/7788dev/qiaoji@main/Qiaoji-1.0.1-windows-amd64-setup.exe",
	}
	for _, raw := range allowed {
		if !allowedInstallerURL(raw) {
			t.Errorf("rejected %q", raw)
		}
	}
	blocked := []string{
		"",
		"https://evil.example/Qiaoji-1.0.1-windows-amd64-setup.exe",
		"https://github.com/other/qiaoji/releases/download/v1.0.1/Qiaoji-1.0.1-windows-amd64-setup.exe",
		"https://github.com/7788dev/qiaoji/releases/download/v1.0.1/notes.md",
		"http://github.com/7788dev/qiaoji/releases/download/v1.0.1/Qiaoji-1.0.1-windows-amd64-setup.exe",
	}
	for _, raw := range blocked {
		if allowedInstallerURL(raw) {
			t.Errorf("allowed %q", raw)
		}
	}
}

func TestChecksumForFile(t *testing.T) {
	body := []byte("d0b78df8ea2e3d2e388daccf9e4aa7ad8cc6f76c7cec33c84416527b4bca1e24  Qiaoji-1.0.1-windows-amd64-setup.exe\n")
	got := checksumForFile(body, "Qiaoji-1.0.1-windows-amd64-setup.exe")
	if got != "d0b78df8ea2e3d2e388daccf9e4aa7ad8cc6f76c7cec33c84416527b4bca1e24" {
		t.Fatalf("got %q", got)
	}
}

func TestSaveInstallerPayload(t *testing.T) {
	payload := append([]byte("MZ"), bytesRepeat(0x41, 1024)...)
	sum := sha256.Sum256(payload)
	want := hex.EncodeToString(sum[:])

	path, err := saveInstallerPayload(strings.NewReader(string(payload)), int64(len(payload)), want, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatal("saved installer did not match payload")
	}

	if _, err := saveInstallerPayload(strings.NewReader(string(payload)), int64(len(payload)), strings.Repeat("a", 64), nil); err == nil {
		t.Fatal("expected checksum failure")
	}
	if _, err := saveInstallerPayload(strings.NewReader("not an exe"), 10, want, nil); err == nil {
		t.Fatal("expected format failure")
	}
}

func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
