package store

import (
	"errors"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// AbsolutePath expands Windows short names without following symbolic links.
// Boundary checks must compare the same spelling before inspecting links; an
// 8.3 alias such as RUNNER~1 is not a symlink or a different directory.
func AbsolutePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	probe := abs
	var suffix []string
	for {
		name, err := windows.UTF16PtrFromString(probe)
		if err != nil {
			return "", err
		}
		buffer := make([]uint16, 260)
		for {
			n, callErr := windows.GetLongPathName(name, &buffer[0], uint32(len(buffer)))
			if callErr != nil {
				err = callErr
				break
			}
			if int(n) >= len(buffer) {
				buffer = make([]uint16, n+1)
				continue
			}
			resolved := windows.UTF16ToString(buffer[:n])
			for i := len(suffix) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, suffix[i])
			}
			return filepath.Clean(resolved), nil
		}
		if !errors.Is(err, windows.ERROR_FILE_NOT_FOUND) && !errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", err
		}
		suffix = append(suffix, filepath.Base(probe))
		probe = parent
	}
}
