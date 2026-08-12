//go:build !windows

package main

func positionIsVisible(x, y, w, h int) bool { return w > 0 && h > 0 }
