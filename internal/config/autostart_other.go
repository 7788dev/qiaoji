//go:build !windows

package config

func ApplyAutostart(bool) error { return nil }

func AutostartEnabled() bool { return false }
