//go:build !windows

package store

import "path/filepath"

// AbsolutePath normalizes a path without following symbolic links.
func AbsolutePath(path string) (string, error) { return filepath.Abs(path) }
