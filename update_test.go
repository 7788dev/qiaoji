package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchLatestReleaseFindsNewVersion(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		if !strings.HasPrefix(r.Header.Get("User-Agent"), "Qiaoji/") {
			t.Errorf("User-Agent = %q", r.Header.Get("User-Agent"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"v1.2.0"}`))
	}))
	defer server.Close()

	info, err := fetchLatestRelease(context.Background(), server.Client(), server.URL, "1.1.9")
	if err != nil {
		t.Fatal(err)
	}
	if !info.Available {
		t.Fatal("expected an available update")
	}
	if info.LatestVersion != "1.2.0" {
		t.Fatalf("LatestVersion = %q", info.LatestVersion)
	}
	if info.ReleaseURL != "https://github.com/7788dev/qiaoji/releases/tag/v1.2.0" {
		t.Fatalf("ReleaseURL = %q", info.ReleaseURL)
	}
}

func TestFetchLatestReleaseHandlesCurrentAndDevelopmentBuilds(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v1.0.0"}`))
	}))
	defer server.Close()

	for _, current := range []string{"1.0.0", "1.1.0", "dev"} {
		info, err := fetchLatestRelease(context.Background(), server.Client(), server.URL, current)
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

func TestFetchLatestReleaseRejectsBadResponses(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"status": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "rate limited", http.StatusForbidden)
		},
		"json": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`not json`))
		},
		"tag": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"tag_name":"latest"}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(handler)
			defer server.Close()
			if _, err := fetchLatestRelease(
				context.Background(),
				server.Client(),
				server.URL,
				"1.0.0",
			); err == nil {
				t.Fatal("expected an error")
			}
		})
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
