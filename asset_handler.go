package main

import (
	"encoding/json"
	"net/http"
	"path/filepath"
)

func (a *App) serveVaultAsset(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/__qiaoji_asset" {
		http.NotFound(w, r)
		return
	}
	v, _, done, err := a.need()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer done()

	switch r.Method {
	case http.MethodGet:
		path, err := v.ResolveAsset(r.URL.Query().Get("note"), r.URL.Query().Get("path"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "private, no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		http.ServeFile(w, r, path)
	case http.MethodPost:
		const maxUpload = 25 << 20
		r.Body = http.MaxBytesReader(w, r.Body, maxUpload+1)
		defer r.Body.Close()
		notePath := r.URL.Query().Get("note")
		relative, err := v.SaveAssetReader(
			notePath,
			r.URL.Query().Get("filename"),
			r.Body,
		)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		// Only a successful write is ours. Marking an invalid upload as a self
		// change could misclassify an unrelated external edit for 1.5 seconds.
		a.markSelfPath(filepath.Dir(notePath), true)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]string{"path": relative})
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
