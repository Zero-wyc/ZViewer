//go:build windows

package controller

// 内嵌网页端信任：WebView2 用 Windows 证书存储校验 HTTPS，
// 自签的 localhost 证书必须先装进当前用户的受信任根存储，否则 iframe 会报证书错误。

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
)

// TrustCA 用 certutil 把根证书加入当前用户的「受信任的根证书颁发机构」。
// 只写当前用户存储（-user），不需要管理员权限，也不影响系统其他账户。
func (c *Certificates) TrustCA() (string, error) {
	paths := c.Paths()
	if !fileExists(paths.CA) {
		return "", errors.New("尚未生成本机根证书，请先在「证书与域名」页签发证书")
	}
	cmd := exec.Command("certutil", "-user", "-addstore", "-f", "Root", paths.CA)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("安装根证书失败：%s", message)
	}
	return "已将本机根证书加入当前用户的受信任根证书", nil
}
