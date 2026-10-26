package controller

// EasyTier 虚拟组网对外接口：桌面对话框只认这几个动作，不直接碰 MeshManager。

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// StartMesh 用已保存的配置入网，并把「打开控制台时自动入网」记进配置。
func (c *Controller) StartMesh() (MeshStatus, error) {
	config := c.store.Value
	secret, err := c.store.MeshSecret()
	if err != nil {
		return c.mesh.Snapshot(), errors.New("组网密钥无法解密，请重新填写网络密钥")
	}
	if config.Mesh.Mode == "config" {
		// 配置文件模式下名称与密钥都写在用户那份 TOML 里，面板字段不参与。
		if _, statErr := os.Stat(c.MeshCustomPath()); statErr != nil {
			return c.mesh.Snapshot(), errors.New("请先在配置文件模式下保存 EasyTier 配置")
		}
	} else {
		if config.Mesh.NetworkName == "" {
			return c.mesh.Snapshot(), errors.New("请先填写网络名称与网络密钥")
		}
		if err := MeshSecretValid(secret); err != nil {
			return c.mesh.Snapshot(), errors.New("请先填写网络密钥")
		}
	}
	if !config.Mesh.Enabled {
		if _, err := c.store.SaveMesh(map[string]any{"enabled": true}, nil); err != nil {
			return c.mesh.Snapshot(), err
		}
	}
	status, err := c.mesh.Start(c.store.Value.Mesh, secret)
	if err != nil {
		// 起不来就不要留下「自动入网」的开关，否则每次打开控制台都重复失败。
		if _, revertErr := c.store.SaveMesh(map[string]any{"enabled": false}, nil); revertErr != nil {
			c.log("回滚组网开关失败："+revertErr.Error(), "mesh", "WARN")
		}
		return status, err
	}
	c.log("EasyTier 虚拟组网已启动："+status.VirtualIP, "mesh", "INFO")
	return status, nil
}

// StopMesh 停止组网，并取消自动入网。
func (c *Controller) StopMesh() (MeshStatus, error) {
	if _, err := c.store.SaveMesh(map[string]any{"enabled": false}, nil); err != nil {
		return c.mesh.Snapshot(), err
	}
	status, err := c.mesh.Stop()
	if err != nil {
		return status, err
	}
	c.log("EasyTier 虚拟组网已停止", "mesh", "INFO")
	return status, nil
}

// SaveMesh 保存组网配置；运行中且入网参数变了就按新参数重新入网。
func (c *Controller) SaveMesh(input map[string]any, secret *string) (Config, error) {
	config, err := c.store.SaveMesh(input, secret)
	if err != nil {
		return config, err
	}
	if !c.mesh.Running() {
		c.log("组网配置已保存", "mesh", "INFO")
		return config, nil
	}
	plain, decryptErr := c.store.MeshSecret()
	if decryptErr != nil || plain == "" {
		return config, nil
	}
	_, restarted, restartErr := c.mesh.Reconfigure(config.Mesh, plain)
	if restartErr != nil {
		return config, restartErr
	}
	if restarted {
		c.log("组网配置已变更，已按新参数重新入网", "mesh", "INFO")
	} else {
		c.log("组网配置已保存", "mesh", "INFO")
	}
	return config, nil
}

// NewMeshCredentials 生成一组新的网络名称与密钥；不落盘，等用户点保存时才写，
// 避免「生成了但没保存」让运行中的节点与配置里记录的凭据对不上。
func (c *Controller) NewMeshCredentials() map[string]any {
	return map[string]any{"networkName": RandomMeshName(), "networkSecret": RandomMeshSecret()}
}

// MeshInvite 生成可以整段发给朋友的入网说明。
func (c *Controller) MeshInvite() (string, error) {
	config := c.store.Value
	name, secret := config.Mesh.NetworkName, ""
	if config.Mesh.Mode == "config" {
		// 配置模式下凭据写在用户那份 TOML 里，从这里读出来。
		raw, err := os.ReadFile(c.MeshCustomPath())
		if err != nil {
			return "", errors.New("请先在配置文件模式下保存 EasyTier 配置")
		}
		name, secret = meshIdentityFromTOML(string(raw))
		if name == "" || secret == "" {
			return "", errors.New("配置文件里缺少 network_name 或 network_secret")
		}
	} else {
		value, err := c.store.MeshSecret()
		if err != nil {
			return "", errors.New("组网密钥无法解密，请重新填写网络密钥")
		}
		if strings.TrimSpace(value) == "" {
			return "", errors.New("请先填写网络密钥")
		}
		secret = value
	}
	meshConfig := config.Mesh
	meshConfig.NetworkName = name
	return meshInvite(meshConfig, secret, c.mesh.Snapshot(), config.Port), nil
}

// ProbePublicPeers 测试公共中继节点的可用性；list 为空时测全部内置候选。
// 结果只用于展示与「一键填写」，不会写进配置。
func (c *Controller) ProbePublicPeers(list []string) []MeshPeerProbe {
	if len(list) == 0 {
		list = MeshPublicPeers()
	}
	results := ProbeMeshPeers(list)
	usable := 0
	for _, item := range results {
		if item.State == "ok" {
			usable++
		}
	}
	c.log(fmt.Sprintf("公共对端服务器探测完成：%d/%d 可连接", usable, len(results)), "mesh", "INFO")
	return results
}

// AutoStartMesh 在控制台启动后按配置入网；失败只记日志，不阻塞界面。
func (c *Controller) AutoStartMesh() {
	config := c.store.Value
	if !config.Mesh.Enabled {
		return
	}
	if !c.mesh.Available() {
		// 组件是按需下载的：没下载时不要当成故障反复重试，只说一句话。
		c.log("组网组件尚未下载，已跳过自动入网", "mesh", "WARN")
		return
	}
	secret, err := c.store.MeshSecret()
	// 配置文件模式下密钥写在用户那份 TOML 里，本地密钥可以为空。
	if config.Mesh.Mode != "config" && (err != nil || secret == "") {
		c.log("组网密钥不可用，已跳过自动入网", "mesh", "WARN")
		return
	}
	if _, err := c.mesh.Start(config.Mesh, secret); err != nil {
		c.log("自动入网未完成："+err.Error(), "mesh", "WARN")
	}
}
