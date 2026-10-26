package controller

import (
	"context"
	"fmt"
	"os"
	"time"
)

// Local installation failures cannot be repaired by downloading the same
// component again from another source.
type cloudflaredInstallError struct{ err error }

func (e *cloudflaredInstallError) Error() string { return e.err.Error() }
func (e *cloudflaredInstallError) Unwrap() error { return e.err }

func retryCloudflaredFileOperation(ctx context.Context, operation func() error) error {
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := operation()
		if err == nil || !retryableCloudflaredFileError(err) || !time.Now().Before(deadline) {
			return err
		}
		if err := waitTunnel(ctx, 100*time.Millisecond); err != nil {
			return err
		}
	}
}

func removeCloudflaredTemporaryFile(path string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = retryCloudflaredFileOperation(ctx, func() error { return os.Remove(path) })
}

func installCloudflared(ctx context.Context, temporary, target string) error {
	backup := ""
	if fileExists(target) {
		// temporary is already unique. Avoid creating another empty .exe that
		// would itself trigger a scanner before we can rename the old version.
		backup = temporary + ".previous"
		if err := retryCloudflaredFileOperation(ctx, func() error { return os.Rename(target, backup) }); err != nil {
			return &cloudflaredInstallError{fmt.Errorf("无法暂存旧版 cloudflared（文件可能仍被其他程序占用）：%w", err)}
		}
	}
	if err := retryCloudflaredFileOperation(ctx, func() error { return os.Rename(temporary, target) }); err != nil {
		if backup != "" {
			// Restoring the existing component must still run after cancellation.
			restoreCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			restoreErr := retryCloudflaredFileOperation(restoreCtx, func() error { return os.Rename(backup, target) })
			cancel()
			if restoreErr != nil {
				return &cloudflaredInstallError{fmt.Errorf("安装 cloudflared 失败：%v；旧版保留在 %s，恢复失败：%w", err, backup, restoreErr)}
			}
		}
		return &cloudflaredInstallError{fmt.Errorf("无法安装 cloudflared（文件可能仍被其他程序占用）：%w", err)}
	}
	if backup != "" {
		removeCloudflaredTemporaryFile(backup)
	}
	return nil
}
