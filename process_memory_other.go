//go:build !windows

package main

type processTreeMemoryStats struct {
	MainBytes    int64
	WebViewBytes int64
	NodeBytes    int64
	OtherBytes   int64
	TotalBytes   int64
	ProcessCount int
}

func processTreeMemory() processTreeMemoryStats { return processTreeMemoryStats{} }
