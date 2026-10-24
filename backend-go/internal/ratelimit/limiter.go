// Package ratelimit 提供进程内的固定窗口限流。
//
// 只覆盖 Node 版 express-rate-limit 在敏感端点上用到的两种维度：
// IP 维度（登录/注册）与用户维度（改密）。刻意不引入 Redis 或外部存储——
// 本项目是单机部署，且限流状态丢失的后果只是放宽，不会误伤。
package ratelimit

import (
	"sync"
	"time"
)

// Limiter 是固定窗口计数器。
//
// 固定窗口会有边界效应（窗口末尾打满、下个窗口立刻又能打满），
// 但对"防暴力破解"这个用途足够，且实现只有滑动窗口的几分之一。
type Limiter struct {
	mu      sync.Mutex
	entries map[string]*window
	limit   int
	period  time.Duration
}

type window struct {
	count int
	reset time.Time
}

// New 构造限流器：period 内同一 key 最多 limit 次。
func New(limit int, period time.Duration) *Limiter {
	return &Limiter{
		entries: make(map[string]*window),
		limit:   limit,
		period:  period,
	}
}

// Result 是一次判定的结果。
type Result struct {
	Allowed bool
	// RetryAfter 仅在 Allowed=false 时有意义，表示距离窗口重置的剩余时长。
	RetryAfter time.Duration
	// Remaining 窗口内剩余次数（已扣除本次）。
	Remaining int
}

// Allow 记录一次访问并返回是否放行。
func (l *Limiter) Allow(key string) Result {
	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	// 顺手清理过期条目：单机场景条目量级是"活跃客户端数"，
	// 每次请求全量扫描带来的开销可以忽略，但能避免内存随历史 key 无限增长。
	l.sweep(now)

	entry, ok := l.entries[key]
	if !ok || now.After(entry.reset) {
		l.entries[key] = &window{count: 1, reset: now.Add(l.period)}
		return Result{Allowed: true, Remaining: l.limit - 1}
	}

	if entry.count >= l.limit {
		return Result{Allowed: false, RetryAfter: entry.reset.Sub(now)}
	}

	entry.count++
	return Result{Allowed: true, Remaining: l.limit - entry.count}
}

// Reset 清除某个 key 的计数（例如登录成功后清掉失败计数）。
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// sweep 删除已过期的窗口。调用方必须持有锁。
func (l *Limiter) sweep(now time.Time) {
	for key, entry := range l.entries {
		if now.After(entry.reset) {
			delete(l.entries, key)
		}
	}
}
