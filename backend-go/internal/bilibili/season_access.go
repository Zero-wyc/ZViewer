package bilibili

import (
	"context"
	"strconv"
)

// SeasonContainsEpisode validates episode membership using authoritative PGC data.
func (s *Service) SeasonContainsEpisode(ctx context.Context, cookie string, seasonID, epID int64) bool {
	season, found, err := s.fetchSeason(ctx, cookie, strconv.FormatInt(seasonID, 10))
	if err != nil || !found {
		return false
	}
	episodes := append([]rawSeasonEpisode{}, season.Episodes...)
	if season.MainSection != nil {
		episodes = append(episodes, season.MainSection.Episodes...)
	}
	for _, section := range season.Section {
		episodes = append(episodes, section.Episodes...)
	}
	for _, ep := range episodes {
		if ep.ID == epID {
			return true
		}
	}
	return false
}
