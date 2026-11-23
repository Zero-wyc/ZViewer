//go:build !windows

package console

// backendExecutableName 返回运行包内后端可执行文件名（类 Unix 无扩展名）。
func backendExecutableName() string { return "zviewer-backend" }
