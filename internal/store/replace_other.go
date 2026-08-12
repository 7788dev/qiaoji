//go:build !windows

package store

import "os"

func replaceFile(source, target string) error {
	return os.Rename(source, target)
}
