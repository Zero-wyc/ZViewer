package anisubs

import (
	"context"
	"fmt"
	"log"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// 「全部站点」聚合搜索。
//
// 一个关键词并发打到所有数据源，合并成一份列表：同名只留一条，每条记下
// 来源站点与「别的站点也有这个标题」，界面据此标来源。
//
// 与 internal/cms 的 SearchAll 有三处刻意的差别：
//  1. **轮转合并**而不是逐站点拼接。anisubs 的源多（默认订阅近 20 个、每站
//     最多 20 条），逐站拼接会让排在前面的几个源把列表占满，后面的源一条都
//     露不出来；按层轮转（各站第 1 条 → 各站第 2 条 → …）保证每个站点都能
//     出现在前面。
//  2. **总预算 + 并发上限**。站点抓取是整页 HTML + 解析，个别站点常年慢；
//     不设预算时一次搜索会被最慢的那个站拖到它自己的 20s 超时。
//  3. **全部失败才算错误**。单站失败是常态（站点改版、被 Cloudflare 拦），
//     不能因为其中几个挂了就让整次搜索失败。
const (
	// aggregateBudget 是整次聚合搜索的时间预算。
	//
	// 到点就带着已有结果返回：慢站点的结果会缺席，但总比让用户盯着加载态
	// 等满每个站的 20s 超时好。默认订阅 18 个源、并发 8，正常站点 1~3s
	// 就能回来，两轮多点就跑完。
	aggregateBudget = 10 * time.Second
	// aggregateConcurrency 是同时在跑的站点抓取数（对上游礼貌一点）。
	aggregateConcurrency = 8
	// aggregateMaxResults 是合并后的条数上限。
	//
	// 去重后仍可能有上百条（不同站点收录的番剧并不相同），再多列表就没法看了。
	// 因为合并是轮转的，截断不会让某个站点整体消失。
	aggregateMaxResults = 120
)

// AggregateResult 是聚合搜索的一条结果。
//
// 内嵌 SearchResult：前端把它当普通搜索结果用（id 仍是站点内的主体 id，
// source 是真实站点 key，选集/解析据此路由），只是多了来源信息。
type AggregateResult struct {
	SearchResult

	// SourceName 是这条结果来自哪个站点（显示用）。
	SourceName string `json:"sourceName"`
	// AltSources 是同样命中这个标题的其他站点名。
	//
	// 只给名字不给 id 是刻意的：聚合列表里同名只留一条，用户真正需要知道的是
	// 「这个片子不止一个站有」——真要在别的站打开，切到那个站点再搜即可。
	AltSources []string `json:"altSources,omitempty"`
}

// aggregateSource 是聚合时用到的站点身份（id 用于路由，name 用于显示）。
type aggregateSource struct {
	ID   string
	Name string
}

// aggregateTitleNoise 是标题归一化时忽略的空白/标点/符号。
var aggregateTitleNoise = regexp.MustCompile(`[\s\p{P}\p{S}]+`)

// normalizeAggregateTitle 标题归一化（小写 + 去空白/标点/符号）。
//
// 用来判断「不同站点给的标题是不是同一部番」：`孤独摇滚！` 与 `孤独摇滚`
// 归一化后相同，`【第2季】` 这类装饰性符号也会被抹掉。
func normalizeAggregateTitle(title string) string {
	return aggregateTitleNoise.ReplaceAllString(strings.ToLower(strings.TrimSpace(title)), "")
}

// mergeAggregate 把各站点的结果轮转合并去重。
//
// perSource[i] 对应 sources[i] 的结果（失败或没搜到就是 nil）。合并规则：
//   - 空标题、空 id 直接丢掉（两种都会让前端渲染出不可点的卡片）；
//   - 归一化标题相同只留先出现的那条，并把后出现站点的名字记进 AltSources；
//   - 先出现的那条缺封面/简介时，用后面那条补齐（同一部番，信息越多越好）。
func mergeAggregate(sources []aggregateSource, perSource [][]SearchResult) []AggregateResult {
	merged := make([]AggregateResult, 0, 32)
	index := make(map[string]int, 32)

	for depth := 0; ; depth++ {
		anyLeft := false
		for position, items := range perSource {
			if depth >= len(items) {
				continue
			}
			anyLeft = true
			item := items[depth]
			title := strings.TrimSpace(item.Title)
			if title == "" || item.ID == "" {
				continue
			}
			if item.Source == "" {
				item.Source = sources[position].ID
			}
			item.Title = title

			key := normalizeAggregateTitle(title)
			if at, ok := index[key]; ok {
				existing := &merged[at]
				if existing.Cover == nil {
					existing.Cover = item.Cover
				}
				if existing.Description == nil {
					existing.Description = item.Description
				}
				name := sources[position].Name
				if name != "" && name != existing.SourceName && !slices.Contains(existing.AltSources, name) {
					existing.AltSources = append(existing.AltSources, name)
				}
				continue
			}

			index[key] = len(merged)
			merged = append(merged, AggregateResult{
				SearchResult: item,
				SourceName:   sources[position].Name,
			})
			if len(merged) >= aggregateMaxResults {
				return merged
			}
		}
		if !anyLeft {
			return merged
		}
	}
}

// SearchAll 聚合搜索全部数据源。
func (s *Service) SearchAll(ctx context.Context, keyword string) ([]AggregateResult, error) {
	trimmed := strings.TrimSpace(keyword)
	if trimmed == "" {
		return []AggregateResult{}, nil
	}
	providers := s.load(ctx)
	if len(providers) == 0 {
		return []AggregateResult{}, nil
	}

	searchCtx, cancel := context.WithTimeout(ctx, aggregateBudget)
	defer cancel()

	perSource := make([][]SearchResult, len(providers))
	failures := make([]error, len(providers))
	slots := make(chan struct{}, aggregateConcurrency)
	var wg sync.WaitGroup
	for index, provider := range providers {
		wg.Add(1)
		go func(index int, provider builtProvider) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			items, err := provider.Provider.Search(searchCtx, trimmed)
			if err != nil {
				failures[index] = err
				log.Printf("[anisubs] 聚合搜索失败 %s: %v", provider.Provider.Name(), err)
				return
			}
			perSource[index] = items
		}(index, provider)
	}
	wg.Wait()

	sources := make([]aggregateSource, len(providers))
	for index, provider := range providers {
		sources[index] = aggregateSource{ID: provider.ID, Name: provider.Provider.Name()}
	}
	results := mergeAggregate(sources, perSource)
	if len(results) > 0 {
		return results, nil
	}
	// 一条都没有时要区分两件事：所有站点都失败（要报错，用户才知道该换关键词
	// 还是该查网络），还是站点都正常但真的没搜到（正常的空结果）。
	if err := allFailed(failures); err != nil {
		return nil, err
	}
	return results, nil
}

// allFailed 在「每一个站点都失败」时返回代表性命中错误，否则返回 nil。
func allFailed(failures []error) error {
	var first error
	for _, err := range failures {
		if err == nil {
			return nil
		}
		if first == nil {
			first = err
		}
	}
	if first == nil {
		return nil
	}
	return fmt.Errorf("所有数据源搜索失败：%v", first)
}

// aggregateCall 是一次进行中的聚合搜索（并发请求合并用）。
type aggregateCall struct {
	done    chan struct{}
	results []AggregateResult
	err     error
}

// SearchAllCoalesced 合并同一关键词的并发聚合搜索。
//
// 房间里两个人同时搜同一个词、或者用户连点搜索，都不该把 18 个站点各抓两遍。
// 与 internal/cms 的同名方法一致：先到的那个真正去抓，后面的等它出结果。
func (s *Service) SearchAllCoalesced(ctx context.Context, keyword string) ([]AggregateResult, error) {
	key := strings.TrimSpace(keyword)

	s.aggregateMu.Lock()
	if call, ok := s.aggregateInflight[key]; ok {
		s.aggregateMu.Unlock()
		// 等结果时也要能被自己的请求取消拽走：客户端断开后没必要继续挂着。
		select {
		case <-call.done:
			return call.results, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &aggregateCall{done: make(chan struct{})}
	if s.aggregateInflight == nil {
		s.aggregateInflight = make(map[string]*aggregateCall, 4)
	}
	s.aggregateInflight[key] = call
	s.aggregateMu.Unlock()

	results, err := s.SearchAll(ctx, key)

	s.aggregateMu.Lock()
	call.results, call.err = results, err
	delete(s.aggregateInflight, key)
	close(call.done)
	s.aggregateMu.Unlock()
	return results, err
}
