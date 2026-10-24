package cms

import (
	"sync"
	"time"
)

// resolveCache 是「TTL + 单飞 + 容量淘汰」的解析结果缓存。
//
// 对应 utils/resolve-cache.ts。多人同时进房间播同一集时，解析会被折叠成
// 一次上游请求；失败结果不缓存（错误传播给所有等待者后即从 inflight 移除，
// 下次自动重试）。
type resolveCache[T any] struct {
	mu       sync.Mutex
	ttlMs    int64
	maxSize  int
	entries  map[string]resolveEntry[T]
	order    []string
	inflight map[string]*resolveCall[T]
}

type resolveEntry[T any] struct {
	value     T
	fetchedAt int64
}

type resolveCall[T any] struct {
	done  chan struct{}
	value T
	err   error
}

func newResolveCache[T any](ttlMs int64, maxSize int) *resolveCache[T] {
	return &resolveCache[T]{
		ttlMs:    ttlMs,
		maxSize:  maxSize,
		entries:  make(map[string]resolveEntry[T], 32),
		order:    make([]string, 0, 32),
		inflight: make(map[string]*resolveCall[T], 8),
	}
}

// run 命中直接返回；未命中执行 fn 并写入缓存；并发同 key 折叠为一次执行。
func (c *resolveCache[T]) run(key string, fn func() (T, error)) (T, error) {
	c.mu.Lock()
	if entry, ok := c.entries[key]; ok {
		if nowMs()-entry.fetchedAt < c.ttlMs {
			c.mu.Unlock()
			return entry.value, nil
		}
		// 过期条目立刻移除：否则下面的容量判断会把它当有效项。
		delete(c.entries, key)
		c.removeOrder(key)
	}
	if call, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-call.done
		return call.value, call.err
	}
	call := &resolveCall[T]{done: make(chan struct{})}
	c.inflight[key] = call
	c.mu.Unlock()

	value, err := fn()

	c.mu.Lock()
	if err == nil {
		if len(c.entries) >= c.maxSize && len(c.order) > 0 {
			oldest := c.order[0]
			c.order = c.order[1:]
			delete(c.entries, oldest)
		}
		c.entries[key] = resolveEntry[T]{value: value, fetchedAt: nowMs()}
		c.order = append(c.order, key)
	}
	call.value, call.err = value, err
	delete(c.inflight, key)
	close(call.done)
	c.mu.Unlock()

	return value, err
}

// removeOrder 从插入序里摘掉一个键（O(n)，缓存规模 ≤500 可接受）。
func (c *resolveCache[T]) removeOrder(key string) {
	for index, candidate := range c.order {
		if candidate == key {
			c.order = append(c.order[:index], c.order[index+1:]...)
			return
		}
	}
}

// nowMs 返回毫秒时间戳（与 JS 的 Date.now() 同语义）。
func nowMs() int64 { return time.Now().UnixMilli() }
