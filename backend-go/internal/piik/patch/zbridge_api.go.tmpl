// ZViewer 桥接层的公开面：上游 signal.Server 的 store 只在 s.mu 内安全，
// 桥接层不能自己去碰 *room.Store，所以把「校验 / 结束」这三个动作开在这里。
//
// 本文件是**新增**，不修改上游任何函数。`patch/` 下这份是母本，
// sync-from-piik.sh 每次同步后把它复制回 server/signal/。
package signal

import "errors"

// ErrHostToken 表示房主凭证与房间不匹配（房间已回收或 token 过期）。
var ErrHostToken = errors.New("host token does not own the room")

// RoomAuthorityValid 报告 hostToken 是否仍是 roomID 的房主凭证。
// 房间被空房回收后返回 false，调用方据此重建房间。
func (s *Server) RoomAuthorityValid(roomID, hostToken string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.store.HostManagedRoom(roomID, hostToken)
	return err == nil
}

// ViewerGrantValid 报告 viewerGrant 对 roomID 是否仍然有效。
func (s *Server) ViewerGrantValid(roomID, viewerGrant string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	ok, err := s.store.ViewerGrantMayEnter(roomID, viewerGrant)
	return err == nil && ok
}

// EndRoom 结束房间并通知已连接会话，相当于房主主动关房。
// hostToken 不匹配时不做任何事（返回 ErrHostToken）。
func (s *Server) EndRoom(roomID, hostToken string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.store.HostManagedRoom(roomID, hostToken); err != nil {
		return ErrHostToken
	}
	return s.abandonRoom(roomID)
}
