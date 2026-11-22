package crawler

import (
	"encoding/json"
	"strconv"
	"strings"
)

// 规则的类型定义与 JSON 读写。
//
// 规则文件是用户资产，字段名以 snake_case 为准；同时兼容 Python 版
// normalize 接受过的驼峰别名（item_selector / playUrlRegex / skipFrom …）。
// 未知键会被丢弃（Python 版会原样保留），这是刻意的取舍：规则 schema
// 由本包唯一裁决，保留未知键只会让「写错的字段名」静默生效。

// RuleFormat 是当前规则格式版本。
const RuleFormat = 1

// 合法的可见性与验证页状态码集合。
var (
	ruleVisibilities    = []string{"public", "root"}
	challengeStatuses   = []int{403, 429, 503} // 供上层参考，非强制
	ruleFieldNames      = []string{"title", "url", "cover", "description", "duration", "author"}
	keywordPlaceholder  = "{keyword}"
	queryPlaceholderAlt = "{query}"
)

// RuleStats 记录规则的使用情况。
type RuleStats struct {
	Searches   int     `json:"searches"`
	Successes  int     `json:"successes"`
	Failures   int     `json:"failures"`
	LastUsedAt *string `json:"last_used_at"`
	LastError  *string `json:"last_error"`
}

// Script 是一段 JS 规则片段。
type Script struct {
	Runtime    string  `json:"runtime"`
	Source     string  `json:"source"`
	TimeoutSec float64 `json:"timeout_sec"`
}

// SearchRequest 描述搜索请求。
type SearchRequest struct {
	Method   string            `json:"method"`
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	BodyType string            `json:"body_type"`
}

// Search 是搜索段。
type Search struct {
	Mode      string        `json:"mode"`
	Request   SearchRequest `json:"request"`
	Encoding  string        `json:"encoding"`
	Script    Script        `json:"script"`
	AccountID string        `json:"account_id"`
}

// Field 是一个字段的抽取规格。
type Field struct {
	Selector string `json:"selector,omitempty"`
	// XPath 是 CSS 选择器的替代（Kazumi 等外站规则只有 XPath）。
	// 容器声明了 container_xpath 时，字段表达式相对容器节点求值。
	XPath  string `json:"xpath,omitempty"`
	Path   string `json:"path,omitempty"`
	Attr   string `json:"attr,omitempty"`
	Regex  string `json:"regex,omitempty"`
	Group  int    `json:"group,omitempty"`
	Prefix string `json:"prefix,omitempty"`
	// Absolute 三态：nil 表示按字段名默认（url/cover 为 true）。
	Absolute *bool `json:"absolute,omitempty"`
}

// Parse 是解析段。
type Parse struct {
	Type      string `json:"type"`
	Container string `json:"container,omitempty"`
	// ContainerXPath 非空时改用 XPath 选条目（Container 忽略）。
	ContainerXPath string           `json:"container_xpath,omitempty"`
	ListPath       string           `json:"list_path,omitempty"`
	Fields         map[string]Field `json:"fields"`
	Script         Script           `json:"script"`
	BaseURL        string           `json:"base_url"`
	DedupeBy       string           `json:"dedupe_by"`
	Limit          int              `json:"limit"`
	// Groups 把某个已抽取字段拆成「线路 + 集数」（CMS/TVBox 的 vod_play_url 形态）。
	Groups *GroupSpec `json:"groups,omitempty"`
}

// Challenge 是人机验证识别段。
type Challenge struct {
	Enabled       bool     `json:"enabled"`
	URLContains   []string `json:"url_contains"`
	TitleContains []string `json:"title_contains"`
	Keywords      []string `json:"keywords"`
	Selectors     []string `json:"selectors"`
	Statuses      []int    `json:"statuses"`
	Script        Script   `json:"script"`
	WaitSelector  string   `json:"wait_selector"`
	WaitSeconds   float64  `json:"wait_seconds"`
	Note          string   `json:"note"`
}

// PlayAPI 是播放地址接口段。
type PlayAPI struct {
	URL      string            `json:"url"`
	Headers  map[string]string `json:"headers"`
	SkipFrom []string          `json:"skipFrom"`
}

// Play 是播放解析段。
type Play struct {
	Headers      map[string]string `json:"headers"`
	Script       Script            `json:"script"`
	API          PlayAPI           `json:"api"`
	PlayURLRegex string            `json:"play_url_regex"`
	EpisodeRegex string            `json:"episode_regex"`
	AccountID    string            `json:"account_id"`
	// Episodes 用解析段描述详情页选集（容器 + title/url 字段）。
	// 有了它，选集就不必依赖 episode_regex 去猜页面结构。
	Episodes *Parse `json:"episodes,omitempty"`
}

// Rule 是一条站点规则。
type Rule struct {
	ID           string    `json:"id,omitempty"`
	Format       int       `json:"format"`
	Name         string    `json:"name"`
	Site         string    `json:"site"`
	Aliases      []string  `json:"aliases"`
	Enabled      bool      `json:"enabled"`
	Visibility   string    `json:"visibility"`
	AllowedRooms []string  `json:"allowed_rooms"`
	CreatedBy    string    `json:"created_by"`
	CreatedAt    string    `json:"created_at"`
	UpdatedAt    string    `json:"updated_at"`
	Version      int       `json:"version"`
	Description  string    `json:"description"`
	Stats        RuleStats `json:"stats"`
	Search       Search    `json:"search"`
	Parse        Parse     `json:"parse"`
	Challenge    Challenge `json:"challenge"`
	Play         *Play     `json:"play,omitempty"`
}

// rawObject 是「先解成键表再手动取」的中间形态，用来实现别名与类型容错。
type rawObject map[string]json.RawMessage

func toRawObject(data []byte) (rawObject, error) {
	var obj rawObject
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, err
	}
	if obj == nil {
		return rawObject{}, nil
	}
	return obj, nil
}

// pick 返回第一个存在且非 null 的值。
func (o rawObject) pick(keys ...string) (json.RawMessage, bool) {
	for _, key := range keys {
		value, ok := o[key]
		if !ok || len(value) == 0 || string(value) == "null" {
			continue
		}
		return value, true
	}
	return nil, false
}

func (o rawObject) str(keys ...string) string {
	value, ok := o.pick(keys...)
	if !ok {
		return ""
	}
	return looseString(value)
}

func (o rawObject) object(keys ...string) rawObject {
	value, ok := o.pick(keys...)
	if !ok {
		return nil
	}
	child, err := toRawObject(value)
	if err != nil {
		return nil
	}
	return child
}

// looseString 等价 Python 的 _text：什么类型都转成去掉首尾空白的字符串。
func looseString(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var str string
	if err := json.Unmarshal(raw, &str); err == nil {
		return strings.TrimSpace(str)
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err == nil {
		return strings.TrimSpace(number.String())
	}
	return strings.TrimSpace(string(raw))
}

// looseFloat 尽力转成浮点数，失败返回 0。
func looseFloat(raw json.RawMessage) float64 {
	text := looseString(raw)
	if text == "" {
		return 0
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0
	}
	return value
}

// looseInt 尽力转成整数，失败返回 0。
func looseInt(raw json.RawMessage) int {
	text := looseString(raw)
	if text == "" {
		return 0
	}
	if value, err := strconv.Atoi(text); err == nil {
		return value
	}
	if value, err := strconv.ParseFloat(text, 64); err == nil {
		return int(value)
	}
	return 0
}

// looseBool 只认 JSON 的 true/false。
func looseBool(raw json.RawMessage) bool {
	var value bool
	if err := json.Unmarshal(raw, &value); err == nil {
		return value
	}
	return false
}

// looseStringMap 把对象转成 map[string]string，忽略 null 值。
func looseStringMap(raw json.RawMessage) map[string]string {
	out := map[string]string{}
	if len(raw) == 0 || string(raw) == "null" {
		return out
	}
	object, err := toRawObject(raw)
	if err != nil {
		return out
	}
	for key, value := range object {
		if len(value) == 0 || string(value) == "null" {
			continue
		}
		out[key] = looseString(value)
	}
	return out
}

// looseStringList 接受字符串或字符串数组，丢弃空项。
func looseStringList(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		trimmed := strings.TrimSpace(single)
		if trimmed == "" {
			return nil
		}
		return []string{trimmed}
	}
	var list []json.RawMessage
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, item := range list {
		text := looseString(item)
		if text != "" {
			out = append(out, text)
		}
	}
	return out
}

func parseScript(raw json.RawMessage) Script {
	if len(raw) == 0 || string(raw) == "null" {
		return Script{}
	}
	// 字符串简写 = 只有 source。
	var source string
	if err := json.Unmarshal(raw, &source); err == nil {
		return Script{Source: source}
	}
	object, err := toRawObject(raw)
	if err != nil {
		return Script{}
	}
	script := Script{
		Runtime: strings.ToLower(object.str("runtime")),
		Source:  object.str("source"),
	}
	if value, ok := object.pick("timeout_sec", "timeoutSec"); ok {
		script.TimeoutSec = looseFloat(value)
	}
	return script
}

func parseField(raw json.RawMessage, kind string) Field {
	if len(raw) == 0 || string(raw) == "null" {
		return Field{}
	}
	// 字符串简写：html 规则是 selector，json 规则是 path。
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		if kind == "json" {
			return Field{Path: text}
		}
		return Field{Selector: text}
	}
	object, err := toRawObject(raw)
	if err != nil {
		return Field{}
	}
	field := Field{
		Selector: object.str("selector"),
		XPath:    object.str("xpath"),
		Path:     object.str("path"),
		Attr:     object.str("attr"),
		Regex:    object.str("regex"),
		Prefix:   object.str("prefix"),
	}
	if value, ok := object.pick("group"); ok {
		field.Group = looseInt(value)
	}
	if value, ok := object.pick("absolute"); ok {
		absolute := looseBool(value)
		field.Absolute = &absolute
	}
	return field
}

func parseFields(raw json.RawMessage, kind string) map[string]Field {
	out := map[string]Field{}
	if len(raw) == 0 || string(raw) == "null" {
		return out
	}
	object, err := toRawObject(raw)
	if err != nil {
		return out
	}
	for name, value := range object {
		out[name] = parseField(value, kind)
	}
	return out
}

// UnmarshalJSON 实现规则读入：只做类型搬运，默认值全部交给 Normalize。
func (r *Rule) UnmarshalJSON(data []byte) error {
	object, err := toRawObject(data)
	if err != nil {
		return err
	}
	r.ID = object.str("id")
	r.Name = object.str("name")
	r.Site = object.str("site")
	r.Aliases = looseStringList(rawOrNil(object, "aliases"))
	r.Description = object.str("description")
	r.CreatedBy = object.str("created_by", "createdBy")
	r.CreatedAt = object.str("created_at", "createdAt")
	r.UpdatedAt = object.str("updated_at", "updatedAt")
	r.Visibility = object.str("visibility")
	// enabled 缺省为 true（与 Python 的 bool(rule.get("enabled", True)) 一致）；
	// 零值无法区分「没写」与「写了 false」，所以在读入时就把默认值定下来。
	r.Enabled = true
	if value, ok := object.pick("enabled"); ok {
		r.Enabled = looseBool(value)
	}
	if value, ok := object.pick("version"); ok {
		r.Version = looseInt(value)
	}
	if value, ok := object.pick("format"); ok {
		r.Format = looseInt(value)
	}
	if value, ok := object.pick("allowed_rooms", "allowedRooms"); ok {
		r.AllowedRooms = looseStringList(value)
	}
	if stats := object.object("stats"); stats != nil {
		r.Stats.Searches = statsInt(stats, "searches")
		r.Stats.Successes = statsInt(stats, "successes")
		r.Stats.Failures = statsInt(stats, "failures")
		if value, ok := stats.pick("last_used_at", "lastUsedAt"); ok {
			text := looseString(value)
			if text != "" {
				r.Stats.LastUsedAt = &text
			}
		}
		if value, ok := stats.pick("last_error", "lastError"); ok {
			text := looseString(value)
			if text != "" {
				r.Stats.LastError = &text
			}
		}
	}
	if search := object.object("search"); search != nil {
		r.Search.Mode = search.str("mode")
		r.Search.Encoding = search.str("encoding")
		r.Search.AccountID = search.str("account_id", "accountId")
		r.Search.Script = parseScript(rawOrNil(search, "script"))
		if request := search.object("request"); request != nil {
			r.Search.Request.Method = request.str("method")
			r.Search.Request.URL = request.str("url")
			r.Search.Request.Body = request.str("body")
			r.Search.Request.BodyType = request.str("body_type", "bodyType")
			r.Search.Request.Headers = looseStringMap(rawOrNil(request, "headers"))
		}
	}
	if parse := object.object("parse"); parse != nil {
		r.Parse = parseParseObject(parse)
	}
	if challenge := object.object("challenge"); challenge != nil {
		if value, ok := challenge.pick("enabled"); ok {
			r.Challenge.Enabled = looseBool(value)
		}
		r.Challenge.URLContains = looseStringList(rawOrNil(challenge, "url_contains", "urlContains"))
		r.Challenge.TitleContains = looseStringList(rawOrNil(challenge, "title_contains", "titleContains"))
		r.Challenge.Keywords = looseStringList(rawOrNil(challenge, "keywords"))
		r.Challenge.Selectors = looseStringList(rawOrNil(challenge, "selectors"))
		for _, item := range looseStringList(rawOrNil(challenge, "statuses")) {
			status := looseIntString(item)
			if status >= 100 && status <= 599 {
				r.Challenge.Statuses = append(r.Challenge.Statuses, status)
			}
		}
		r.Challenge.Script = parseScript(rawOrNil(challenge, "script"))
		r.Challenge.WaitSelector = challenge.str("wait_selector", "waitSelector")
		if value, ok := challenge.pick("wait_seconds", "waitSeconds"); ok {
			r.Challenge.WaitSeconds = looseFloat(value)
		}
		r.Challenge.Note = challenge.str("note")
	}
	if raw, ok := object.pick("play"); ok {
		var probe map[string]json.RawMessage
		if err := json.Unmarshal(raw, &probe); err == nil && len(probe) > 0 {
			play := &Play{}
			r.Play = play
			object := rawObject(probe)
			play.Headers = looseStringMap(rawOrNil(object, "headers"))
			play.Script = parseScript(rawOrNil(object, "script"))
			play.PlayURLRegex = object.str("play_url_regex", "playUrlRegex")
			play.EpisodeRegex = object.str("episode_regex", "episodeRegex")
			play.AccountID = object.str("account_id", "accountId")
			if api := object.object("api"); api != nil {
				play.API.URL = api.str("url")
				play.API.Headers = looseStringMap(rawOrNil(api, "headers"))
				play.API.SkipFrom = looseStringList(rawOrNil(api, "skipFrom", "skip_from"))
			}
			if episodes := object.object("episodes"); episodes != nil {
				parsed := parseParseObject(episodes)
				play.Episodes = &parsed
			}
		}
	}
	return nil
}

// parseParseObject 解析一个「抽取段」（parse 与 play.episodes 共用）。
func parseParseObject(object rawObject) Parse {
	out := Parse{
		Type:           object.str("type"),
		Container:      object.str("container", "item_selector", "itemSelector"),
		ContainerXPath: object.str("container_xpath", "containerXPath"),
		ListPath:       object.str("list_path", "listPath"),
		BaseURL:        object.str("base_url", "baseUrl"),
		DedupeBy:       object.str("dedupe_by", "dedupeBy"),
		Script:         parseScript(rawOrNil(object, "script")),
	}
	out.Fields = parseFields(rawOrNil(object, "fields"), out.Type)
	if value, ok := object.pick("limit"); ok {
		out.Limit = looseInt(value)
	}
	if groups := object.object("groups"); groups != nil {
		out.Groups = &GroupSpec{
			Field:       groups.str("field"),
			NamesField:  groups.str("names_field", "namesField"),
			GroupSep:    groups.str("group_sep", "groupSep"),
			EpisodeSep:  groups.str("episode_sep", "episodeSep"),
			NameSep:     groups.str("name_sep", "nameSep"),
			URLTemplate: groups.str("url_template", "urlTemplate"),
		}
	}
	return out
}

func rawOrNil(object rawObject, keys ...string) json.RawMessage {
	if value, ok := object.pick(keys...); ok {
		return value
	}
	return nil
}

func statsInt(object rawObject, key string) int {
	if value, ok := object.pick(key); ok {
		return looseInt(value)
	}
	return 0
}

func looseIntString(text string) int {
	value, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		return 0
	}
	return value
}
