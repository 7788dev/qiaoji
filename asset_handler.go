package main

import (
	"net/http"
)

func (a *App) serveVaultAsset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.URL.Path != "/__qiaoji_asset" {
		http.NotFound(w, r)
		return
	}
	v, _, done, err := a.need()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer done()

	path, err := v.ResolveAsset(r.URL.Query().Get("note"), r.URL.Query().Get("path"))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}
