package controller

import (
	"errors"

	"golang.org/x/sys/windows"
)

// Windows scanners may briefly hold a freshly written executable without
// FILE_SHARE_DELETE, including after its writer has closed the file.
func retryableCloudflaredFileError(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) ||
		errors.Is(err, windows.ERROR_LOCK_VIOLATION) ||
		errors.Is(err, windows.ERROR_ACCESS_DENIED)
}
