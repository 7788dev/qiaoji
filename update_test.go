package main

import (
	"context"
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
	info := fillUpdateInfo("1.0.0", "1.0.1", "https://evil.example/update")
	if info.ReleaseURL != repoURL {
		t.Fatalf("ReleaseURL = %q", info.ReleaseURL)
	}
	if !info.Available {
		t.Fatal("expected an available update")
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
	tag, page, ok := parseVersionPayload(body)
	if !ok {
		t.Fatalf("could not parse version.json: %s", body)
	}
	if _, valid := parseReleaseVersion(tag); !valid {
		t.Fatalf("invalid version %q", tag)
	}
	if page != "" && !allowedReleaseURL(page) {
		t.Fatalf("url %q is not the project repository", page)
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
