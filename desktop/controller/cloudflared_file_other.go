//go:build !windows

package controller

func retryableCloudflaredFileError(error) bool { return false }
