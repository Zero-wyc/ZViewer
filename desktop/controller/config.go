package controller

// 配置层：与 desktop/lib/config.cjs 语义一一对应。
// 迁移原则：先保证读写的字段、校验顺序与错误文案完全一致，
// 已有用户的 settings.json 可以原样接管。

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Config 对应 config.cjs 的 defaults。
type Config struct {
	Port            int    `json:"port"`
	RtmpPort        int    `json:"rtmpPort"`
	FlvPort         int    `json:"flvPort"`
	LivekitPort     int    `json:"livekitPort"`
	LivekitTcpPort  int    `json:"livekitTcpPort"`
	BindHost        string `json:"bindHost"`
	Https           bool   `json:"https"`
	CloseToTray     bool   `json:"closeToTray"`
	LaunchAtLogin   bool   `json:"launchAtLogin"`
	AutoStart       bool   `json:"autoStart"`
	AutoCheckUpdate bool   `json:"autoCheckUpdate"`
	UpdateProxy     bool   `json:"updateProxy"`
	UpdateProxyURL  string `json:"updateProxyUrl"`
	// UpdateGitCode 选择更新源：true=GitCode 大陆镜像（默认），false=GitHub。
	UpdateGitCode bool `json:"updateGitCode"`
	// CloudflaredSource 独立控制隧道组件的版本检查与下载，与 GUI 自身更新源无关。
	CloudflaredSource string     `json:"cloudflaredSource"`
	Domain            string     `json:"domain"`
	LanIP             string     `json:"lanIp"`
	Cli               CliConfig  `json:"cli"`
	Frp               FrpConfig  `json:"frp"`
	Mesh              MeshConfig `json:"mesh"`
}

type CliConfig struct {
	Port      int    `json:"port"`
	AutoStart bool   `json:"autoStart"`
	User      string `json:"user"`
}

type FrpConfig struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	AdvertiseIP string `json:"advertiseIp"`
	Voice       bool   `json:"voice"`
	Rtmp        bool   `json:"rtmp"`
	Tcp         bool   `json:"tcp"`
	WebPort     int    `json:"webPort"`
	VoicePort   int    `json:"voicePort"`
	RtmpPort    int    `json:"rtmpPort"`
	TcpPort     int    `json:"tcpPort"`
	// Mode 选择配置来源：form 由表单生成 frpc 配置，config 直接运行用户
	// 粘贴或导入的整份配置文件。
	Mode string `json:"mode"`
	// Format 是自定义配置文件的格式，frpc 按扩展名识别。
	Format string `json:"format"`
}

func DefaultConfig() Config {
	return Config{
		Port: 3333, RtmpPort: 3334, FlvPort: 3335, LivekitPort: 3336, LivekitTcpPort: 3337,
		// 默认监听所有地址：双栈 `::` 同时覆盖回环（localhost/127.0.0.1/::1）、
		// 局域网 IPv4 与 IPv6。仅本机使用可在“应用设置”改回 127.0.0.1。
		BindHost: "::", Https: false,
		CloseToTray: true, LaunchAtLogin: false, AutoStart: false, AutoCheckUpdate: true,
		UpdateProxy: true, UpdateProxyURL: DefaultUpdateProxy, UpdateGitCode: true,
		CloudflaredSource: cloudflaredSourceProxy,
		Domain:            "localhost", LanIP: "",
		Cli: CliConfig{Port: 9333, AutoStart: false, User: ""},
		Frp: FrpConfig{Host: "", Port: 7000, AdvertiseIP: "", Voice: true, Rtmp: true, Tcp: false,
			WebPort: 3333, VoicePort: 3333, RtmpPort: 3334, TcpPort: 3337, Mode: "form", Format: "toml"},
		Mesh: DefaultMeshConfig(),
	}
}

// Clone 值语义拷贝：Config 全部是标量字段，直接赋值即可。
func (c Config) Clone() Config { return c }

// Map 把结构体摊平成前端/校验函数使用的 map 形式。
func (c Config) Map() map[string]any { return toMap(c) }

func toMap(value any) map[string]any {
	raw, err := json.Marshal(value)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return map[string]any{}
	}
	return out
}

var digitsOnly = regexp.MustCompile(`^\d+$`)

func isDigits(value string) bool { return digitsOnly.MatchString(value) }

// portOf 复刻 config.cjs 的 port()：字符串数字与整数都接受，范围 1–65535。
func portOf(value any) (int, bool) {
	switch n := value.(type) {
	case float64:
		if n != math.Trunc(n) || math.IsInf(n, 0) {
			return 0, false
		}
		if n < 1 || n > 65535 {
			return 0, false
		}
		return int(n), true
	case int:
		if n < 1 || n > 65535 {
			return 0, false
		}
		return n, true
	case string:
		if !isDigits(n) {
			return 0, false
		}
		parsed, err := strconv.Atoi(n)
		if err != nil || parsed < 1 || parsed > 65535 {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}

func asString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok
}

func asBool(value any) bool {
	flag, ok := value.(bool)
	return ok && flag
}

// IsHostname 与 config.cjs 的 hostname() 等价：IP 或合法域名。
func IsHostname(value string) bool {
	if len(value) == 0 || len(value) > 253 {
		return false
	}
	if net.ParseIP(value) != nil {
		return true
	}
	if regexp.MustCompile(`^[\d.]+$`).MatchString(value) {
		return false
	}
	label := regexp.MustCompile(`^[a-zA-Z\d](?:[a-zA-Z\d-]{0,61}[a-zA-Z\d])?$`)
	for _, part := range strings.Split(value, ".") {
		if !label.MatchString(part) {
			return false
		}
	}
	return true
}

func frpMapOf(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// Validate 校验并归一化配置，错误文案与前端提示保持一致。
func Validate(input map[string]any) (Config, error) { return validateConfig(input, false) }

// validateConfig 的 meshSecretPresent 表示当前用户已有可用的组网密钥密文；
// 只有「启用组网」才要求密钥，避免旧配置在没有密钥时整份校验失败。
func validateConfig(input map[string]any, meshSecretPresent bool) (Config, error) {
	target := DefaultConfig()
	base := toMap(target)
	for key, value := range input {
		base[key] = value
	}

	ports := []struct {
		key string
		dst *int
	}{
		{"port", &target.Port},
		{"rtmpPort", &target.RtmpPort},
		{"flvPort", &target.FlvPort},
		{"livekitPort", &target.LivekitPort},
		{"livekitTcpPort", &target.LivekitTcpPort},
	}
	for _, spec := range ports {
		value, ok := portOf(base[spec.key])
		if !ok {
			return target, fmt.Errorf("%s 需要填写 1–65535 的整数", spec.key)
		}
		*spec.dst = value
	}
	// LiveKit 信令端口固定为主项目的 HTTP_PORT（3336），面板只读展示、不再接受修改；
	// 旧配置里存过其他值的，加载或保存时一并收回这个值。
	target.LivekitPort = 3336
	seen := map[int]bool{}
	for _, spec := range ports {
		if seen[*spec.dst] {
			return target, errors.New("网页、RTMP、FLV、LiveKit 信令和语音 TCP 端口不能重复")
		}
		seen[*spec.dst] = true
	}
	reserved := []int{target.Port, target.RtmpPort, target.FlvPort, target.LivekitPort, target.LivekitTcpPort}

	// 图形控制台之前保存的配置里可能没有 cli 段：端口若与主服务冲突就顺延。
	cliInput := frpMapOf(base["cli"])
	cli := DefaultConfig().Cli
	if raw, exists := cliInput["port"]; exists {
		value, ok := portOf(raw)
		if !ok {
			return target, errors.New("高画质代理端口需要填写 1–65535 的整数")
		}
		cli.Port = value
	} else {
		cli.Port = 9333
		for containsInt(reserved, cli.Port) {
			cli.Port++
		}
	}
	user := cli.User
	if raw, exists := cliInput["user"]; exists {
		text, ok := asString(raw)
		if !ok || len([]rune(text)) > 120 || hasControlChar(text) {
			return target, errors.New("ZViewer 网页账号格式无效")
		}
		user = text
	}
	if len([]rune(user)) > 120 || hasControlChar(user) {
		return target, errors.New("ZViewer 网页账号格式无效")
	}
	cli.User = strings.TrimSpace(user)
	cli.AutoStart = asBool(cliInput["autoStart"])
	target.Cli = cli
	if containsInt(reserved, cli.Port) {
		return target, errors.New("高画质代理端口不能与其他服务 TCP 端口重复")
	}

	frp := DefaultConfig().Frp
	patch := frpMapOf(base["frp"])
	if _, exists := patch["voicePort"]; !exists {
		frp.VoicePort = target.Port
	}
	if _, exists := patch["webPort"]; !exists {
		frp.WebPort = target.Port
	}
	if _, exists := patch["tcpPort"]; !exists {
		frp.TcpPort = target.LivekitTcpPort
	}

	bind, ok := asString(base["bindHost"])
	if !ok || (bind != "127.0.0.1" && bind != "0.0.0.0" && bind != "::") {
		return target, errors.New("监听地址无效")
	}
	target.BindHost = bind
	target.Https = asBool(base["https"])
	target.CloseToTray = asBool(base["closeToTray"])
	target.LaunchAtLogin = asBool(base["launchAtLogin"])
	target.AutoStart = asBool(base["autoStart"])
	target.AutoCheckUpdate = asBool(base["autoCheckUpdate"])
	target.UpdateProxy = asBool(base["updateProxy"])
	proxy, ok := asString(base["updateProxyUrl"])
	if !ok {
		return target, errors.New("更新反代地址无效")
	}
	proxy, err := NormalizeUpdateProxy(proxy)
	if err != nil {
		return target, err
	}
	target.UpdateProxyURL = proxy
	source, ok := asString(base["cloudflaredSource"])
	if !ok || (source != cloudflaredSourceProxy && source != cloudflaredSourceGitHub) {
		return target, errors.New("cloudflared 获取源无效，请选择 GitHub 前置反代或 GitHub 官方")
	}
	target.CloudflaredSource = source
	// 老配置里没有这个键：缺省保持默认 true（GitCode），不要被 asBool 的零值改回 false。
	// 值类型不对时同样保留默认，而不是当成「关闭」。
	if raw, exists := base["updateGitCode"]; exists {
		if flag, ok := raw.(bool); ok {
			target.UpdateGitCode = flag
		}
	}

	domain, ok := asString(base["domain"])
	if !ok || !IsHostname(domain) || net.ParseIP(domain) != nil {
		return target, errors.New("证书域名无效")
	}
	if raw, exists := base["lanIp"]; exists {
		text, isText := asString(raw)
		if !isText || (text != "" && net.ParseIP(text) == nil) {
			return target, errors.New("内网 IP 无效")
		}
		target.LanIP = text
	}
	target.Domain = strings.ToLower(domain)

	frp.Host = ""
	if raw, exists := patch["host"]; exists {
		text, isText := asString(raw)
		if !isText {
			return target, errors.New("VPS 地址应为 IP 或域名，不包含协议、端口或路径")
		}
		frp.Host = text
	}
	if frp.Host != "" && !IsHostname(frp.Host) {
		return target, errors.New("VPS 地址应为 IP 或域名，不包含协议、端口或路径")
	}
	if raw, exists := patch["advertiseIp"]; exists {
		text, isText := asString(raw)
		if !isText {
			return target, errors.New("语音公布地址需要填写 VPS 的 IPv4 地址")
		}
		frp.AdvertiseIP = text
	}
	if frp.AdvertiseIP != "" {
		parsed := net.ParseIP(frp.AdvertiseIP)
		if parsed == nil || parsed.To4() == nil {
			return target, errors.New("语音公布地址需要填写 VPS 的 IPv4 地址")
		}
	}

	frpPorts := []struct {
		key string
		dst *int
	}{
		{"port", &frp.Port},
		{"webPort", &frp.WebPort},
		{"voicePort", &frp.VoicePort},
		{"rtmpPort", &frp.RtmpPort},
		{"tcpPort", &frp.TcpPort},
	}
	for _, spec := range frpPorts {
		if raw, exists := patch[spec.key]; exists {
			value, ok := portOf(raw)
			if !ok {
				return target, fmt.Errorf("FRP %s 端口无效", spec.key)
			}
			*spec.dst = value
			continue
		}
		// 未显式提供的远端端口沿用上面推导出的默认值。
		value, ok := portOf(*spec.dst)
		if !ok {
			return target, fmt.Errorf("FRP %s 端口无效", spec.key)
		}
		*spec.dst = value
	}
	frp.Voice, frp.Rtmp = true, true
	if raw, exists := patch["voice"]; exists {
		frp.Voice = asBool(raw)
	}
	if raw, exists := patch["rtmp"]; exists {
		frp.Rtmp = asBool(raw)
	}
	frp.Tcp = asBool(patch["tcp"])

	if frp.AdvertiseIP != "" && frp.Voice && frp.VoicePort != target.Port {
		return target, fmt.Errorf("使用 VPS 公布语音地址时，远端 UDP 端口需与本地语音端口 %d 一致", target.Port)
	}
	if frp.AdvertiseIP != "" && frp.Tcp && frp.TcpPort != target.LivekitTcpPort {
		return target, fmt.Errorf("使用 VPS 公布语音地址时，远端 TCP 语音端口需与本地语音端口 %d 一致", target.LivekitTcpPort)
	}
	tcpPorts := []int{frp.WebPort}
	if frp.Rtmp {
		tcpPorts = append(tcpPorts, frp.RtmpPort)
	}
	if frp.Tcp {
		tcpPorts = append(tcpPorts, frp.TcpPort)
	}
	if len(uniqueInts(tcpPorts)) != len(tcpPorts) {
		return target, errors.New("FRP 同一协议的远端端口不能重复")
	}

	// 自定义配置模式下，这些表单字段只作为“按图形配置填充”的素材，仍照常校验。
	frp.Mode = "form"
	if raw, exists := patch["mode"]; exists {
		text, isText := asString(raw)
		if !isText || (text != "form" && text != "config") {
			return target, errors.New("FRP 配置方式无效")
		}
		frp.Mode = text
	}
	frp.Format = "toml"
	if raw, exists := patch["format"]; exists {
		text, isText := asString(raw)
		if !isText {
			return target, errors.New("FRP 配置文件格式无效")
		}
		normalized, valid := normalizeFrpFormat(text)
		if !valid {
			return target, errors.New("FRP 配置文件格式无效")
		}
		frp.Format = normalized
	}
	target.Frp = frp

	mesh, err := NormalizeMesh(frpMapOf(base["mesh"]), DefaultMeshConfig(), meshSecretPresent, reserved)
	if err != nil {
		return target, err
	}
	target.Mesh = mesh
	return target, nil
}

func containsInt(list []int, value int) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func uniqueInts(list []int) []int {
	seen := map[int]bool{}
	out := make([]int, 0, len(list))
	for _, item := range list {
		if seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

func hasControlChar(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// Atomic 与 config.cjs 的 atomic() 一致：先写临时文件再替换，权限 0600。
func Atomic(file, contents string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	buffer := make([]byte, 5)
	_, _ = rand.Read(buffer)
	temp := file + "." + hex.EncodeToString(buffer) + ".tmp"
	if err := os.WriteFile(temp, []byte(contents), 0o600); err != nil {
		return err
	}
	if err := os.Rename(temp, file); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

var envLine = regexp.MustCompile(`^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$`)

// EnvValues 解析运行包根目录下的 .env。
func EnvValues(root string) map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(filepath.Join(root, ".env"))
	if err != nil {
		return out
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	for _, line := range regexp.MustCompile(`\r?\n`).Split(text, -1) {
		match := envLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		value := match[2]
		if len(value) >= 2 {
			first := value[0]
			if (first == '\'' || first == '"') && value[len(value)-1] == first {
				value = value[1 : len(value)-1]
			} else {
				value = regexp.MustCompile(`\s+#.*$`).ReplaceAllString(value, "")
			}
		}
		out[match[1]] = value
	}
	return out
}

// Cipher 抽象 FRP Token 的加密存储；Windows 下由 DPAPI 实现。
type Cipher interface {
	Encrypt(string) (string, error)
	Decrypt(string) (string, error)
}

// Store 负责 settings.json 的读写与密钥加密。
type Store struct {
	file       string
	cipher     Cipher
	Value      Config
	secret     string
	meshSecret string
}

type savedSettings struct {
	Schema     int            `json:"schema"`
	Config     map[string]any `json:"config"`
	FrpToken   string         `json:"frpToken"`
	MeshSecret string         `json:"meshSecret"`
}

// NewStore 读取现有配置；不存在的字段按默认值补齐。
func NewStore(dir, root string, cipher Cipher) (*Store, error) {
	store := &Store{file: filepath.Join(dir, "settings.json"), cipher: cipher, Value: DefaultConfig()}
	raw, err := os.ReadFile(store.file)
	if err == nil {
		var saved savedSettings
		if err := json.Unmarshal(raw, &saved); err != nil {
			return nil, fmt.Errorf("配置文件格式错误：%w", err)
		}
		config := saved.Config
		if config == nil {
			config = map[string]any{}
		}
		if saved.Schema < 2 {
			if frp, ok := config["frp"].(map[string]any); ok {
				if value, ok := frp["voicePort"].(float64); ok && value == 3333 {
					if port, ok := config["port"]; ok {
						if n, ok := portOf(port); ok {
							frp["voicePort"] = float64(n)
						}
					}
				}
			}
		}
		value, err := validateConfig(config, saved.MeshSecret != "")
		if err != nil {
			return nil, err
		}
		store.Value = value
		store.secret = saved.FrpToken
		store.meshSecret = saved.MeshSecret
		return store, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	env := EnvValues(root)
	seed := map[string]any{}
	if text, ok := env["PORT"]; ok {
		seed["port"] = text
	}
	if text, ok := env["RTMP_PORT"]; ok {
		seed["rtmpPort"] = text
	}
	if text, ok := env["HTTP_FLV_PORT"]; ok {
		seed["flvPort"] = text
	}
	if text, ok := env["HOST"]; ok {
		seed["bindHost"] = text
	}
	if text, ok := env["HTTPS"]; ok {
		seed["https"] = text == "true"
	}
	value, err := Validate(seed)
	if err != nil {
		return nil, err
	}
	store.Value = value
	return store, nil
}

// Save 合并补丁并落盘；token 为 nil 表示保留已保存的 Token。
func (s *Store) Save(patch map[string]any, token *string) (Config, error) {
	current := toMap(s.Value)
	frp := toMap(s.Value.Frp)
	patchFrp := frpMapOf(patch["frp"])
	for key, value := range patchFrp {
		frp[key] = value
	}
	// 本地端口改动时，跟随它的远端映射一起改，除非用户显式指定。
	pairs := [][2]string{{"port", "voicePort"}, {"port", "webPort"}, {"livekitTcpPort", "tcpPort"}}
	for _, pair := range pairs {
		local, remote := pair[0], pair[1]
		patchLocal, hasLocal := patch[local]
		if !hasLocal {
			continue
		}
		if _, hasRemote := patchFrp[remote]; hasRemote {
			continue
		}
		if sameNumber(frp[remote], current[local]) {
			frp[remote] = patchLocal
		}
	}
	merged := map[string]any{}
	for key, value := range current {
		merged[key] = value
	}
	for key, value := range patch {
		merged[key] = value
	}
	cli := map[string]any{}
	for key, value := range toMap(s.Value.Cli) {
		cli[key] = value
	}
	for key, value := range frpMapOf(patch["cli"]) {
		cli[key] = value
	}
	merged["cli"] = cli
	merged["frp"] = frp
	merged["mesh"] = mergeMeshMap(s.Value.Mesh, patch["mesh"])

	value, err := validateConfig(merged, s.meshSecret != "")
	if err != nil {
		return s.Value, err
	}
	secret := s.secret
	if token != nil && *token != "" {
		if len(*token) > 4096 || strings.ContainsAny(*token, "\r\n\x00") {
			return s.Value, errors.New("密钥格式无效")
		}
		secret, err = s.cipher.Encrypt(*token)
		if err != nil {
			return s.Value, err
		}
	}
	if err := s.persist(value, secret, s.meshSecret); err != nil {
		return s.Value, err
	}
	s.Value = value
	s.secret = secret
	return value, nil
}

// mergeMeshMap 合并组网补丁：前端可以只提交被改动的一项。
func mergeMeshMap(current MeshConfig, patch any) map[string]any {
	out := toMap(current)
	for key, value := range frpMapOf(patch) {
		out[key] = value
	}
	return out
}

// persist 整份写回 settings.json；三份密文各自独立，缺一不可。
func (s *Store) persist(config Config, frpToken, meshSecret string) error {
	payload, err := json.MarshalIndent(map[string]any{
		"schema": 2, "config": config, "frpToken": frpToken, "meshSecret": meshSecret,
	}, "", "  ")
	if err != nil {
		return err
	}
	return Atomic(s.file, string(payload))
}

// SaveMesh 保存组网配置与密钥；secret 为 nil 表示沿用已保存的密钥。
func (s *Store) SaveMesh(input map[string]any, secret *string) (Config, error) {
	merged := toMap(s.Value)
	merged["mesh"] = mergeMeshMap(s.Value.Mesh, input)
	pending := s.meshSecret
	if secret != nil {
		if err := MeshSecretValid(*secret); err != nil {
			return s.Value, err
		}
		encrypted, err := s.cipher.Encrypt(*secret)
		if err != nil {
			return s.Value, err
		}
		pending = encrypted
	}
	value, err := validateConfig(merged, pending != "")
	if err != nil {
		return s.Value, err
	}
	if err := s.persist(value, s.secret, pending); err != nil {
		return s.Value, err
	}
	s.Value = value
	s.meshSecret = pending
	return value, nil
}

// MeshSecret 解密已保存的组网密钥。
func (s *Store) MeshSecret() (string, error) {
	if s.meshSecret == "" {
		return "", nil
	}
	return s.cipher.Decrypt(s.meshSecret)
}

// HasMeshSecret 只判断是否存在密文，不触发解密。
func (s *Store) HasMeshSecret() bool { return s.meshSecret != "" }

// Token 解密已保存的 FRP Token。
func (s *Store) Token() (string, error) {
	if s.secret == "" {
		return "", nil
	}
	return s.cipher.Decrypt(s.secret)
}

// HasToken 只判断是否存在密文，不触发解密。
func (s *Store) HasToken() bool { return s.secret != "" }

func sameNumber(a, b any) bool {
	left, okLeft := portOf(a)
	right, okRight := portOf(b)
	return okLeft && okRight && left == right
}
