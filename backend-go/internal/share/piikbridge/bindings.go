package piikbridge

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"

	"zviewer/backend/internal/piik/server/protocol"
)

// bindingFileName 是「ZViewer 房间 → Piik 房间码」的映射文件。
//
// 为什么要单独存一份明文 token/grant：Piik 的 room 库里只放摘要
// （`host_token_digest` / `viewer_grant_digest`），拿不回原文。房间本体能靠
// 数据库恢复，但没有明文凭证就没人能再进这个房间——房主会撞 INVALID_TOKEN，
// 观众手里的 grant 也一起作废，持久化就白做了。所以映射跟房间库一起落在
// 同一个目录，权限 0600，且只在进程自己手里。
const bindingFileName = "piik-bindings.json"

const bindingVersion = 1

// bindingDocument 是文件的外层结构。带 version 是为了以后换格式时有据可依，
// 而不是靠猜字段。
type bindingDocument struct {
	Version int             `json:"version"`
	Rooms   []storedBinding `json:"rooms"`
}

type storedBinding struct {
	ZViewerRoomID string `json:"zviewerRoomId"`
	PiikRoomID    string `json:"piikRoomId"`
	HostToken     string `json:"hostToken"`
	ViewerGrant   string `json:"viewerGrant"`
}

// bindingFile 是映射文件的读写端。写入走「临时文件 + rename」，避免进程
// 在写到一半时被杀掉，留下半个 JSON 把下次启动的映射全吃掉。
type bindingFile struct {
	path string
}

// openBindingFile 读取映射文件。
//
// 返回的 error 有两种含义，用 file 是否为 nil 区分：
//
//   - file 非 nil + error：文件内容坏了。已把原文件挪到 `<path>.corrupt`，
//     返回空映射，调用方可以照常继续写——宁可丢一次映射（房间会在空房超时后
//     回收），也不要让一个手改坏的逗号把共享整体拦在门外。
//   - file 为 nil + error：文件读不动（权限、坏盘）。写回去也大概率失败，
//     调用方应退回纯内存。
//
// 文件不存在是正常情况（第一次启动），返回空映射即可。
func openBindingFile(path string) (*bindingFile, map[string]binding, error) {
	rooms := map[string]binding{}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &bindingFile{path: path}, rooms, nil
		}
		return nil, nil, err
	}
	var document bindingDocument
	if err := json.Unmarshal(data, &document); err != nil {
		backup := path + ".corrupt"
		if renameErr := os.Rename(path, backup); renameErr != nil {
			return &bindingFile{path: path}, rooms, fmt.Errorf(
				"房间映射文件无法解析，且备份失败: %w", err)
		}
		return &bindingFile{path: path}, rooms, fmt.Errorf(
			"房间映射文件无法解析（已备份到 %s）: %w", backup, err)
	}
	for _, stored := range document.Rooms {
		current, ok := stored.toBinding()
		if !ok {
			continue
		}
		rooms[stored.ZViewerRoomID] = current
	}
	return &bindingFile{path: path}, rooms, nil
}

func (stored storedBinding) toBinding() (binding, bool) {
	if stored.ZViewerRoomID == "" {
		return binding{}, false
	}
	if !protocol.ValidRoomCode(stored.PiikRoomID) {
		return binding{}, false
	}
	if stored.HostToken == "" || stored.ViewerGrant == "" {
		return binding{}, false
	}
	return binding{
		roomID: stored.PiikRoomID,
		token:  stored.HostToken,
		grant:  stored.ViewerGrant,
	}, true
}

// save 整份重写。映射最多几十条（一个进程同时在开的房间数），重写比增量
// 追加简单得多，也不会出现「追加到一半」的中间态。
func (f *bindingFile) save(rooms map[string]binding) error {
	document := bindingDocument{
		Version: bindingVersion,
		Rooms:   make([]storedBinding, 0, len(rooms)),
	}
	for roomID, current := range rooms {
		document.Rooms = append(document.Rooms, storedBinding{
			ZViewerRoomID: roomID,
			PiikRoomID:    current.roomID,
			HostToken:     current.token,
			ViewerGrant:   current.grant,
		})
	}
	// 按房间 ID 排序：同样的映射永远写出同样的字节，diff 里不会全是噪声。
	sort.Slice(document.Rooms, func(i, j int) bool {
		return document.Rooms[i].ZViewerRoomID < document.Rooms[j].ZViewerRoomID
	})
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeFileAtomically(f.path, data)
}

func writeFileAtomically(path string, data []byte) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	// CreateTemp 已经是 0600；显式再设一次是因为 Windows 上只保证「新文件不带
	// 继承来的宽权限」，不同版本表现不一致。
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}
