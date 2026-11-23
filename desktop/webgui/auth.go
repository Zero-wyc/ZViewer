package webgui

// 网页端鉴权：初始密码、登录会话、改密、登录限速。
//
// 设计取舍：
//   - 密码校验只依赖 PBKDF2-SHA256 的盐与派生值（21 万轮，OWASP 2023 建议量级）；
//     同时把当前密码明文写在状态目录的 webgui-password.txt（0600），用于启动脚本和
//     桌面控制台回显初始密码——没有它，用户第一次打开网页端根本不知道该输什么；
//   - 服务一启动就保证有密码：没有就随机生成一个，因此不存在「谁先扫到端口谁设密码」
//     的窗口，也不做「本机免密」——反代后面回环判断不可靠，一律要求登录；
//   - 会话只存在内存里：进程重启后浏览器要重新登录，换来的是「登出即失效」和
//     没有可被窃取的会话文件；
//   - 登录失败按 IP 与全局两个维度限速，失败统一再睡 300ms，压住在线爆破的
//     吞吐同时不给「密码对不对」的计时侧信道。

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	authFileVersion = 1
	pbkdf2Iter      = 210000
	pbkdf2KeyLen    = 32
	sessionCookie   = "zviewer_web_session"
	sessionTTL      = 7 * 24 * time.Hour
	// credentialFileName 是明文密码文件：鉴权不用它，只给启动脚本/桌面控制台回显。
	credentialFileName = "webgui-password.txt"
)

// authState 是 webgui-auth.json 的落盘结构。
type authState struct {
	Version    int    `json:"version"`
	Salt       string `json:"salt"`
	Hash       string `json:"hash"`
	Iterations int    `json:"iterations"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
}

// authStore 管理密码与会话。零值不可用，必须经 loadAuth 构造。
type authStore struct {
	mu         sync.Mutex
	path       string
	state      authState
	passwordOK bool
	// credentialPath/credential 是 webgui-password.txt 的路径与明文密码，
	// 只用于「显示初始密码」，鉴权仍然走密码哈希。
	credentialPath string
	passwordPlain  string
	sessions map[string]time.Time
	// 登录限速：每个来源 IP 的失败时间戳 + 全局失败时间戳。
	failures map[string][]time.Time
	global   []time.Time
}

// loadAuth 读取密码状态；文件不存在或损坏都当作「还没设密码」。
func loadAuth(stateDir string) *authStore {
	store := &authStore{
		path:           filepath.Join(stateDir, "webgui-auth.json"),
		credentialPath: filepath.Join(stateDir, credentialFileName),
		sessions:       map[string]time.Time{},
		failures:       map[string][]time.Time{},
	}
	if plain, err := os.ReadFile(store.credentialPath); err == nil {
		store.passwordPlain = strings.TrimSpace(string(plain))
	}
	raw, err := os.ReadFile(store.path)
	if err != nil {
		return store
	}
	var state authState
	if json.Unmarshal(raw, &state) != nil {
		return store
	}
	if state.Version != authFileVersion || state.Salt == "" || state.Hash == "" {
		return store
	}
	if state.Iterations <= 0 {
		state.Iterations = pbkdf2Iter
	}
	store.state = state
	store.passwordOK = true
	return store
}

// passwordSet 报告是否已设置鉴权密码。
func (s *authStore) passwordSet() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.passwordOK
}

// credential 返回当前密码明文（没有记录时为空串）。
func (s *authStore) credential() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.passwordPlain
}

// ensureCredential 保证服务一启动就有可用密码：
// 从未设置过密码时随机生成一个并落盘，返回生成结果（已有密码时返回空串）。
// 这样网页端从第一次打开就要求登录，也不存在「谁先扫到端口谁设密码」的窗口。
func (s *authStore) ensureCredential(stateDir string) (string, error) {
	s.mu.Lock()
	set := s.passwordOK
	current := s.passwordPlain
	s.mu.Unlock()
	if set && current != "" {
		return "", nil
	}
	if set {
		// 老版本升级上来：只有哈希没有明文，无法回显，保持不动等用户重设。
		return "", nil
	}
	password, err := randomPassword(passwordLength)
	if err != nil {
		return "", err
	}
	if err := s.setPassword(stateDir, password); err != nil {
		return "", err
	}
	return password, nil
}

// setPassword 设置鉴权密码并落盘。
func (s *authStore) setPassword(stateDir, password string) error {
	if len(password) < 6 {
		return errors.New("密码至少 6 位")
	}
	if len(password) > 128 {
		return errors.New("密码不能超过 128 位")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	hash, err := pbkdf2.Key(sha256.New, password, salt, pbkdf2Iter, pbkdf2KeyLen)
	if err != nil {
		return err
	}
	state := authState{
		Version:    authFileVersion,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Hash:       base64.StdEncoding.EncodeToString(hash),
		Iterations: pbkdf2Iter,
		UpdatedAt:  time.Now().Format(time.RFC3339),
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return err
	}
	if err := writeCredentialFile(filepath.Join(stateDir, credentialFileName), password); err != nil {
		return err
	}
	s.mu.Lock()
	s.state = state
	s.passwordOK = true
	s.passwordPlain = password
	s.mu.Unlock()
	return nil
}

// writeCredentialFile 把明文密码写进状态目录（0600），供启动脚本/桌面控制台读取。
func writeCredentialFile(path, password string) error {
	content := password + "\n"
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// verifyPassword 校验密码；未设置密码时一律不通过（调用方先判断）。
func (s *authStore) verifyPassword(password string) bool {
	s.mu.Lock()
	state := s.state
	set := s.passwordOK
	s.mu.Unlock()
	if !set {
		return false
	}
	salt, err := base64.StdEncoding.DecodeString(state.Salt)
	if err != nil {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(state.Hash)
	if err != nil {
		return false
	}
	iterations := state.Iterations
	if iterations <= 0 {
		iterations = pbkdf2Iter
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iterations, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// newSession 生成会话令牌；cookie 值就是它。
func (s *authStore) newSession() (string, time.Time) {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token := base64.RawURLEncoding.EncodeToString(raw)
	expiry := time.Now().Add(sessionTTL)
	s.mu.Lock()
	s.sessions[token] = expiry
	s.mu.Unlock()
	return token, expiry
}

// validSession 校验会话并顺手清理过期项。
func (s *authStore) validSession(token string) bool {
	if token == "" {
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.sessions[token]
	if !ok {
		return false
	}
	if now.After(expiry) {
		delete(s.sessions, token)
		return false
	}
	return true
}

// dropSession 登出。
func (s *authStore) dropSession(token string) {
	s.mu.Lock()
	delete(s.sessions, token)
	s.mu.Unlock()
}

// pruneSessions 清掉过期的会话（定时调用，避免长期运行内存缓慢增长）。
func (s *authStore) pruneSessions() {
	now := time.Now()
	s.mu.Lock()
	for token, expiry := range s.sessions {
		if now.After(expiry) {
			delete(s.sessions, token)
		}
	}
	s.mu.Unlock()
}

// 限速参数：同一个 IP 5 分钟内最多 5 次失败；全局 5 分钟 20 次。
const (
	rateWindow       = 5 * time.Minute
	ratePerIPLimit   = 5
	rateGlobalLimit  = 20
	loginFailureWait = 300 * time.Millisecond
)

// loginAllowed 判断来源 IP 是否还能尝试登录。
func (s *authStore) loginAllowed(ip string) bool {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := now.Add(-rateWindow)
	recent := pruneTimes(s.failures[ip], cutoff)
	s.failures[ip] = recent
	global := pruneTimes(s.global, cutoff)
	s.global = global
	return len(recent) < ratePerIPLimit && len(global) < rateGlobalLimit
}

// recordFailure 记录一次失败（登录或 setup code 错误）。
func (s *authStore) recordFailure(ip string) {
	s.mu.Lock()
	s.failures[ip] = append(s.failures[ip], time.Now())
	s.global = append(s.global, time.Now())
	// 顺手清掉长时间不活跃的 IP，防止 map 无限增长。
	if len(s.failures) > 4096 {
		cutoff := time.Now().Add(-rateWindow)
		keys := make([]string, 0, len(s.failures))
		for key, stamps := range s.failures {
			if len(pruneTimes(stamps, cutoff)) == 0 {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			delete(s.failures, key)
		}
	}
	s.mu.Unlock()
}

func pruneTimes(stamps []time.Time, cutoff time.Time) []time.Time {
	out := stamps[:0]
	for _, stamp := range stamps {
		if stamp.After(cutoff) {
			out = append(out, stamp)
		}
	}
	return out
}

// passwordLength 是自动生成的初始密码长度。
const passwordLength = 12

// randomPassword 生成 n 位随机初始密码（去掉 0/O/1/I 等易混字符，方便手输）。
func randomPassword(length int) (string, error) {
	return randomCode(length)
}

// randomCode 生成 n 位 base32（去掉易混字符）的一次性设置码。
func randomCode(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, length)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, length)
	for index, value := range buf {
		out[index] = alphabet[int(value)%len(alphabet)]
	}
	return string(out), nil
}