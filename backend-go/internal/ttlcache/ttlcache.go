package ttlcache

import (
	"sync"
	"time"
)

// Cache 是「TTL + 单飞 + 容量淘汰」的结果缓存。
//
// 对应 backend/src/utils/resolve-cache.ts。多人同时进房间播同一集时，
// 解析会被折叠成一次上游请求；失败结果**不缓存**（错误传播给所有等待者后
// 即从 inflight 移除，下次自动重试）。
type Cache[T any] struct {
	mu       sync.Mutex
	ttlMs    int64
	maxSize  int
	entries  map[string]entry[T]
	order    []string
	inflight map[string]*call[T]
}

type entry[T any] struct {
	value     T
	fetchedAt int64
}

type call[T any] struct {
	done  chan struct{}
	value T
	err   error
}

// New 构造缓存。
func New[T any](ttlMs int64, maxSize int) *Cache[T] {
	return &Cache[T]{
		ttlMs:    ttlMs,
		maxSize:  maxSize,
		entries:  make(map[string]entry[T], 32),
		order:    make([]string, 0, 32),
		inflight: make(map[string]*call[T], 8),
	}
}

// Run 命中直接返回；未命中执行 fn 并写入缓存；并发同 key 折叠为一次执行。
func (c *Cache[T]) Run(key string, fn func() (T, error)) (T, error) {
	c.mu.Lock()
	if cached, ok := c.entries[key]; ok {
		if time.Now().UnixMilli()-cached.fetchedAt < c.ttlMs {
			c.mu.Unlock()
			return cached.value, nil
		}
		// 过期条目立刻移除：否则下面的容量判断会把它当有效项。
		delete(c.entries, key)
		c.removeOrder(key)
	}
	if pending, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &call[T]{done: make(chan struct{})}
	c.inflight[key] = pending
	c.mu.Unlock()

	value, err := fn()

	c.mu.Lock()
	if err == nil {
		if len(c.entries) >= c.maxSize && len(c.order) > 0 {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.entries, oldest)
		}
		c.entries[key] = entry[T]{value: value, fetchedAt: time.Now().UnixMilli()}
		c.order = append(c.order, key)
	}
	pending.value, pending.err = value, err
	delete(c.inflight, key)
	close(pending.done)
	c.mu.Unlock()

	return value, err
}

// removeOrder 从插入序里摘掉一个键（O(n)，缓存规模 ≤500 可接受）。
func (c *Cache[T]) removeOrder(key string) {
	for index, candidate := range c.order {
		if candidate == key {
			c.order = append(c.order[:index], c.order[index+1:]...)
			return
		}
	}
}
