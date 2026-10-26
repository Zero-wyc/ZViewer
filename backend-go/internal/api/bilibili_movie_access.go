package api

import (
	"context"
	"strconv"

	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/store"
)

// Bind the credential loan to the stored video/season and its listed episodes.
// Never use caller-supplied metadata to widen the allowed resource set.
func (s *Server) bilibiliMovieMatches(ctx context.Context, movie *store.Movie, target string) bool {
	if movie.Source == nil || *movie.Source != "bilibili" {
		return false
	}
	stored := bilibili.ExpandShortLink(ctx, movie.URL)
	bv := bilibili.ExtractBvid(stored)
	if bv != "" {
		return bv == bilibili.ExtractBvid(target)
	}
	id, requested := bilibili.ExtractBangumiID(stored), bilibili.ExtractBangumiID(target)
	if id == nil || requested == nil {
		return false
	}
	if *id == *requested {
		return true
	}
	// Seasons allow their actual episodes after membership is resolved with the
	// server's Bilibili service, not from movie.Pages (which users can edit).
	if id.SeasonID > 0 && requested.EpID > 0 {
		cookie := ""
		owner, err := s.Movies.RoomOwnerUserID(ctx, movie.ID)
		if err == nil && owner > 0 {
			cookie = s.Bilibili.Creds.GetCookie(ctx, strconv.FormatInt(owner, 10))
		}
		return s.Bilibili.SeasonContainsEpisode(ctx, cookie, id.SeasonID, requested.EpID)
	}
	return false
}
