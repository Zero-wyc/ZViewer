package webgui

// 网页端会话与登录限速。
//
// 账号密码不在这里维护：网页控制台直接校验 ZViewer 的超级管理员账号
// （数据库 user 表 role=root，bcrypt 哈希），见 adminauth.go。
// 这样「网页端密码」和「ZViewer 密码」不会再分叉成两套。
//
// 设计取舍：
//   - 会话只存在内存里：进程重启后浏览器要重新登录，换来的是「登出即失效」和
//     没有可被窃取的会话文件；
//   - 登录失败按 IP 与全局两个维度限速，失败统一再睡 300ms，压住在线爆破的
//     吞吐同时不给「密码对不对」的计时侧信道。

import (
	"crypto/rand"
	"encoding/base64"
	"sort"
	"sync"
	"time"
)

const (
	sessionCookie = "zviewer_web_session"
	sessionTTL    = 7 * 24 * time.Hour
)

// authStore 管理会话与登录限速。
type authStore struct {
	mu       sync.Mutex
	sessions map[string]time.Time
	// 登录限速：每个来源 IP 的失败时间戳 + 全局失败时间戳。
	failures map[string][]time.Time
	global   []time.Time
}

func newAuthStore() *authStore {
	return &authStore{
		sessions: map[string]time.Time{},
		failures: map[string][]time.Time{},
	}
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

// recordFailure 记录一次失败。
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
