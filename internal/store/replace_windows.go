//go:build windows

package store

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

func replaceFile(source, target string) error {
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		err = os.Rename(source, target)
		if err == nil {
			return nil
		}
		if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) &&
			!errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			return err
		}
		if attempt < 3 {
			time.Sleep(50 * time.Millisecond)
		}
	}
	return err
}
