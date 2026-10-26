package api

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/emby"
	"zviewer/backend/internal/store"
)

type imageGrant struct {
	MountID  int64  `json:"m"`
	ItemID   string `json:"i"`
	Kind     string `json:"k"`
	Tag      string `json:"t,omitempty"`
	UserID   int64  `json:"u,omitempty"`
	MovieID  int64  `json:"v,omitempty"`
	Revision string `json:"r,omitempty"`
}

func (s *Server) signImageGrant(grant imageGrant) string {
	if s.Tokens == nil {
		return ""
	}
	resource, _ := json.Marshal(grant)
	return s.Tokens.SignCapability("poster", string(resource), time.Hour)
}

func (s *Server) authorizedEmbyEntries(r *http.Request, kind embyLikeKind, mount *store.Mount, items []emby.EmbyItem) []embyEntry {
	entries := mapEmbyEntries(items)
	for i := range entries {
		e := &entries[i]
		if e.Path == nil {
			continue
		}
		tag := derefOr(e.ImageTag, "")
		cap := s.signImageGrant(imageGrant{MountID: mount.ID, ItemID: *e.Path, Kind: kind.MountType, Tag: tag, UserID: mount.UserID, Revision: mount.UpdatedAt.String()})
		e.ImageTag = &cap
	}
	return entries
}

func (s *Server) verifyImageGrant(r *http.Request, token, kind string, mountID int64, itemID string) (imageGrant, bool) {
	var grant imageGrant
	if s.Tokens == nil {
		return grant, false
	}
	resource, err := s.Tokens.VerifyCapability(token, "poster")
	if err != nil || json.Unmarshal([]byte(resource), &grant) != nil || grant.MountID != mountID || grant.ItemID != itemID || grant.Kind != kind {
		return grant, false
	}
	mount, err := s.Mounts.FindByID(r.Context(), mountID, kind)
	if err != nil {
		return grant, false
	}
	if grant.MovieID > 0 {
		movie, err := s.Movies.FindByID(r.Context(), grant.MovieID)
		if err != nil || movie.SourceMountID == nil || *movie.SourceMountID != mountID || derefOr(movie.Source, "") != kind {
			return grant, false
		}
		cover, err := url.Parse(derefOr(movie.Cover, ""))
		if err != nil || cover.Query().Get("itemId") != itemID {
			return grant, false
		}
		room, err := s.Rooms.FindByRoomID(r.Context(), movie.RoomID)
		return grant, err == nil && room.Status == "active"
	}
	return grant, grant.UserID > 0 && mount.UserID == grant.UserID && mount.UpdatedAt.String() == grant.Revision
}

func (s *Server) authorizedMovieDTO(movie *store.Movie) movieDTO {
	dto := toMovieDTO(movie)
	if derefOr(movie.Source, "") == "server-files" && movie.Path != nil {
		dto.URL = "/api/server-files/proxy?movieId=" + strconv.FormatInt(movie.ID, 10)
	}
	kind := derefOr(movie.Source, "")
	if (kind != "emby" && kind != "jellyfin") || movie.SourceMountID == nil || movie.Path == nil || movie.Cover == nil {
		return dto
	}
	u, err := url.Parse(*movie.Cover)
	if err != nil {
		return dto
	}
	endpoint := "/api/" + kind + "/mounts/" + strconv.FormatInt(*movie.SourceMountID, 10) + "/image"
	// Historical localhost, private channels and path prefixes are recognized only
	// with the authoritative mount and item identity. External covers are untouched.
	if !strings.HasSuffix(u.Path, endpoint) || u.Query().Get("itemId") == "" {
		return dto
	}
	cap := s.signImageGrant(imageGrant{MountID: *movie.SourceMountID, ItemID: u.Query().Get("itemId"), Kind: kind, MovieID: movie.ID})
	q := url.Values{"itemId": {u.Query().Get("itemId")}, "maxWidth": {"600"}, "tag": {cap}}
	cover := endpoint + "?" + q.Encode()
	dto.Cover = &cover
	return dto
}
