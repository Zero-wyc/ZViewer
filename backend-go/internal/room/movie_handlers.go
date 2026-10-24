package room

import (
	"context"
	"encoding/json"
	"strings"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 影片列表的 socket 侧（对应 Node 的 MovieListHandler）。
//
// REST 与 socket 两条写路径共用同一个 store 层，但**不是同一套校验**：
// REST 强制 url/title 必填、会按挂载表补全凭证、内网地址强制转代理；
// socket 路径（Node 的 add-movie）一条都没有，它直接调 createMovie。
// 所以这里也不能顺手复用 REST 的入参校验，否则前端通过 socket 添加的
// 「先占位后补链接」影片会被拒绝，而 Node 版接受。

func (s *Service) bindMovieList(sc *sio.Socket) {
	sc.On("add-movie", func(args []json.RawMessage, ack func(...any)) {
		s.handleAddMovie(sc, args, ack)
	})
	sc.On("remove-movie", func(args []json.RawMessage, ack func(...any)) {
		s.handleRemoveMovie(sc, args, ack)
	})
	sc.On("play-movie", func(args []json.RawMessage, ack func(...any)) {
		s.handlePlayMovie(sc, args, ack)
	})
	sc.On("request-movie-list", func(args []json.RawMessage, ack func(...any)) {
		s.handleRequestMovieList(sc, args, ack)
	})
	sc.On("request-current-movie", func(args []json.RawMessage, ack func(...any)) {
		s.handleRequestCurrentMovie(sc, args, ack)
	})
}

// canPerform 是 canViewerPerform 的失败即拒绝包装。
func (s *Service) canPerform(ctx context.Context, ack func(...any), sc *sio.Socket, roomID, action, denyMessage string) bool {
	ok, err := s.CanViewerPerform(ctx, sc.ID, socketRole(sc), roomID, action)
	if err != nil {
		s.Logger.Printf("[room] 权限判定失败 %s/%s: %v", roomID, action, err)
		ackFail(ack, denyMessage)
		return false
	}
	if !ok {
		ackFail(ack, denyMessage)
		return false
	}
	return true
}

type addMoviePayload struct {
	RoomID string          `json:"roomId"`
	Movie  json.RawMessage `json:"movie"`
}

func (s *Service) handleAddMovie(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[addMoviePayload](args)

	if !s.canPerform(ctx, ack, sc, payload.RoomID, "addMovie", "无权限添加影片") {
		return
	}
	if s.MovieRepo == nil {
		ackFail(ack, "添加影片失败")
		return
	}

	input := parseMovieInput(payload.Movie)
	if _, err := s.MovieRepo.Create(ctx, payload.RoomID, input, userIDOrZero(socketUserID(sc))); err != nil {
		s.Logger.Printf("[add-movie] 新增影片失败: %v", err)
		ackFail(ack, "添加影片失败")
		return
	}

	if err := s.BroadcastMovieList(ctx, payload.RoomID); err != nil {
		s.Logger.Printf("[add-movie] 广播影片列表失败: %v", err)
	}
	ackOK(ack, nil)
}

type movieIDPayload struct {
	RoomID  string          `json:"roomId"`
	MovieID json.RawMessage `json:"movieId"`
}

func (s *Service) handleRemoveMovie(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[movieIDPayload](args)

	if !s.canPerform(ctx, ack, sc, payload.RoomID, "manageMovie", "无权限移除影片") {
		return
	}
	movieID, ok := parseLooseInt(payload.MovieID)
	if !ok || s.MovieRepo == nil {
		ackFail(ack, "影片不存在")
		return
	}

	removed, err := s.MovieRepo.Delete(ctx, payload.RoomID, movieID)
	if err != nil {
		s.Logger.Printf("[remove-movie] 删除影片失败: %v", err)
		ackFail(ack, "移除影片失败")
		return
	}
	if !removed {
		ackFail(ack, "影片不存在")
		return
	}

	// BroadcastMovieList 会自动处理「删掉的正是当前播放的影片」：
	// 清空 currentMovieId 并广播 current-movie={movieId:null}。
	if err := s.BroadcastMovieList(ctx, payload.RoomID); err != nil {
		s.Logger.Printf("[remove-movie] 广播影片列表失败: %v", err)
	}
	ackOK(ack, nil)
}

// currentMoviePayload 是 current-movie 的载荷。
//
// MovieID **不带** omitempty：Node 无论「有没有在播」都带这个键
// （没在播就是 `{movieId: null}`），前端按值判断而不是按键存在判断。
type currentMoviePayload struct {
	MovieID *int64 `json:"movieId"`
}

func (s *Service) handlePlayMovie(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[movieIDPayload](args)

	if !s.canPerform(ctx, ack, sc, payload.RoomID, "manageMovie", "无权限播放影片") {
		return
	}
	movieID, ok := parseLooseInt(payload.MovieID)
	if !ok {
		ackFail(ack, "影片不存在")
		return
	}

	// 只能在「已在列表里」的影片之间切换：列表是运行时状态（由
	// BroadcastMovieList 与 DB 同步），直接放行任意 id 会让前端拿到一个
	// 列表里不存在的 currentMovie，播放页与列表对不上。
	if !containsID(s.MovieIDs(payload.RoomID), movieID) {
		ackFail(ack, "影片不存在")
		return
	}

	s.SetCurrentMovie(payload.RoomID, movieID)
	if s.Hub != nil {
		// 这里用 EmitRoom 而不是 EmitRoomExcept：切换当前影片要同步给
		// **包括发起者在内**的所有人（Node 用的是 io.to(roomId)）。
		s.Hub.EmitRoom(payload.RoomID, "current-movie", currentMoviePayload{MovieID: &movieID})
	}
	ackOK(ack, nil)
}

func (s *Service) handleRequestMovieList(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[roomPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}
	// 只回给请求者自己（Node 是 socket.emit，不是广播）。
	sc.Emit("movie-list", map[string]any{"movies": s.Movies(payload.RoomID)})
	ackOK(ack, nil)
}

func (s *Service) handleRequestCurrentMovie(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[roomPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}
	// Node 的 getCurrentMovieId 对「从没选过片」与「选过又清空」都返回 null，
	// 所以这个 key **恒存在**（值可能为 null），不能写成 omitempty。
	sc.Emit("current-movie", currentMoviePayload{MovieID: s.currentMovieID(payload.RoomID)})
	ackOK(ack, nil)
}

// ---------- 解析工具 ----------

// movieInputBody 是 socket add-movie 的 payload.movie 形状。
//
// 与 REST 的 movieBody 字段一致，但缺省语义更宽松：Node 的 createMovie
// 对每个字段都做 `typeof x === 'string'` / `=== true` / `!== false` 判断，
// 类型不符就当没传，不报错。
type movieInputBody struct {
	URL               *string         `json:"url"`
	Title             *string         `json:"title"`
	Cover             *string         `json:"cover"`
	Source            *string         `json:"source"`
	AudioURL          *string         `json:"audioUrl"`
	Format            *string         `json:"format"`
	VideoCodec        *string         `json:"videoCodec"`
	AudioCodec        *string         `json:"audioCodec"`
	Duration          *float64        `json:"duration"`
	Cid               *int64          `json:"cid"`
	CurrentQn         *int64          `json:"currentQn"`
	AcceptQuality     json.RawMessage `json:"acceptQuality"`
	Pages             json.RawMessage `json:"pages"`
	CurrentPage       *int64          `json:"currentPage"`
	ServerURL         *string         `json:"serverUrl"`
	Path              *string         `json:"path"`
	Username          *string         `json:"username"`
	Password          *string         `json:"password"`
	DirectLink        *bool           `json:"directLink"`
	ServerProxy       *bool           `json:"serverProxy"`
	WasmEngine        *bool           `json:"wasmEngine"`
	PlaysvideoEnabled *bool           `json:"playsvideoEnabled"`
	MultiVersion      *bool           `json:"multiVersion"`
	SourceMeta        json.RawMessage `json:"sourceMeta"`
}

// parseMovieInput 把 socket 载荷转成 store 入参。
//
// 空的 / 缺失的 movie 字段全部按零值处理（Node 是 `payload.movie ?? {}`），
// 不在这里拦「url 为空」——REST 会拦，socket 路径历史上不拦。
func parseMovieInput(raw json.RawMessage) store.MovieInput {
	var body movieInputBody
	if len(raw) > 0 {
		trimmed := strings.TrimSpace(string(raw))
		if trimmed != "" && trimmed != "null" {
			if err := json.Unmarshal(raw, &body); err != nil {
				// 载荷形状不对时按空对象处理：Node 那边 `data.url` 也是
				// undefined，落库的是一条空影片而不是抛错。
				body = movieInputBody{}
			}
		}
	}

	in := store.MovieInput{
		Cover:             body.Cover,
		Source:            body.Source,
		AudioURL:          body.AudioURL,
		Format:            body.Format,
		VideoCodec:        body.VideoCodec,
		AudioCodec:        body.AudioCodec,
		Duration:          body.Duration,
		Cid:               body.Cid,
		CurrentQn:         body.CurrentQn,
		AcceptQuality:     body.AcceptQuality,
		Pages:             body.Pages,
		CurrentPage:       body.CurrentPage,
		ServerURL:         body.ServerURL,
		Path:              body.Path,
		Username:          body.Username,
		Password:          body.Password,
		DirectLink:        body.DirectLink != nil && *body.DirectLink,
		ServerProxy:       body.ServerProxy != nil && *body.ServerProxy,
		WasmEngine:        body.WasmEngine != nil && *body.WasmEngine,
		MultiVersion:      body.MultiVersion != nil && *body.MultiVersion,
		SourceMeta:        body.SourceMeta,
		PlaysVideoEnabled: body.PlaysvideoEnabled == nil || *body.PlaysvideoEnabled,
	}
	// url / title 是 trim 后入库（store 层还会再 trim 一次，这里提前归一
	// 是为了与「必填校验看的是 trim 后的值」保持同一份判断）。
	if body.URL != nil {
		in.URL = *body.URL
	}
	if body.Title != nil {
		in.Title = *body.Title
	}
	return in
}

// parseLooseInt 兼容 number 与数字字符串（Node 侧用 String 化比较）。
func parseLooseInt(raw json.RawMessage) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	if strings.HasPrefix(trimmed, `"`) {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			return 0, false
		}
		trimmed = strings.TrimSpace(s)
	}
	var out int64
	if trimmed == "" {
		return 0, false
	}
	for i := 0; i < len(trimmed); i++ {
		c := trimmed[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		out = out*10 + int64(c-'0')
	}
	return out, true
}

// userIDOrZero 见 settings_handlers.go（*int64 → int64，nil 归 0）。
