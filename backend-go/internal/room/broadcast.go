package room

import "context"

// MovieList 是房间影片列表的「可下发形态」。
//
// DTOs 由 api 层构造（字段定义在那边），room 包只负责原样广播与
// 用 IDs 校验 currentMovieId 是否还在列表里——多一层字段转换就多一处
// 与 Node 侧悄悄漂移的机会。
type MovieList struct {
	DTOs []any
	IDs  []int64
}

// MovieLister 由 api 层注入：按 roomID 读库并序列化影片 DTO。
type MovieLister func(ctx context.Context, roomID string) (*MovieList, error)

// SetMovieLister 注入影片列表读取器。
//
// 用注入而不是让 room 包直接 import api：api 依赖 room（注册 handler），
// 反向依赖会形成 import cycle。
func (s *Service) SetMovieLister(fn MovieLister) { s.movieLister = fn }

// BroadcastMovieList 把 DB 里的影片列表同步到运行时状态并广播给房间。
//
// 房主注册时必须调一次：后端重启后内存里的影片列表是空的，
// 不恢复的话 play-movie 会一直报「影片不存在」，currentMovieId 永远是 null。
//
// 若当前播放的影片已不在列表里（例如 REST 侧刚删掉），额外广播
// current-movie={movieId:null}——观众端靠这条事件停止播放，少了它
// 会出现「列表里没这片，播放器还在放」。
func (s *Service) BroadcastMovieList(ctx context.Context, roomID string) error {
	if s.movieLister == nil {
		return nil
	}
	list, err := s.movieLister(ctx, roomID)
	if err != nil {
		return err
	}
	s.SetMovies(roomID, list.DTOs, list.IDs)
	var playbackErr error

	if cur := s.CurrentMovieID(roomID); cur != nil {
		if id, ok := asInt64(cur); ok && !containsID(list.IDs, id) {
			s.SetCurrentMovie(roomID, nil)
			s.SetPlayback(roomID, nil)
			s.SetSubtitle(roomID, nil)
			// A current-movie=null broadcast alone is insufficient: the next
			// heartbeat or reconnect could restore the deleted source from memory.
			playbackErr = s.Playback.Clear(ctx, roomID)
			if s.Hub != nil {
				s.Hub.EmitRoom(roomID, "current-movie", map[string]any{"movieId": nil})
			}
		}
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(roomID, "movie-list", map[string]any{"movies": list.DTOs})
	}
	return playbackErr
}

// asInt64 把运行时状态里的 currentMovieId 归一成 int64。
//
// 它可能是 int64（本地写入）或 string（从别处还原），两种都要认，
// 否则「删掉正在播的影片」这条分支永远不触发。
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case int32:
		return int64(n), true
	case float64:
		return int64(n), true
	case string:
		var out int64
		ok := true
		if n == "" {
			return 0, false
		}
		for _, c := range n {
			if c < '0' || c > '9' {
				ok = false
				break
			}
			out = out*10 + int64(c-'0')
		}
		return out, ok
	}
	return 0, false
}

func containsID(ids []int64, id int64) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
