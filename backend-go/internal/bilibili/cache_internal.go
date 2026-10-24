package bilibili

import (
	"container/list"
	"sync"
	"time"
)

// defaultCacheMaxSize 与 utils/ttl-cache.ts 的 DEFAULT_MAX_SIZE 一致。
const defaultCacheMaxSize = 500

type cacheEntry[V any] struct {
	key       string
	value     V
	expiresAt time.Time
}

// ttlCache 是 TTL + LRU 内存缓存，语义对齐 utils/ttl-cache.ts：
//   - 读取时惰性过期；
//   - 命中刷新活跃度；
//   - 超容量按最久未使用淘汰。
//
// 之所以要照抄 LRU 而不是裸 map：B站 解析的键里包含 bvid / Cookie 摘要，
// 长期运行的无界 map 会随观看历史线性增长。
type ttlCache[V any] struct {
	mu      sync.Mutex
	ttl     time.Duration
	maxSize int
	items   map[string]*list.Element
	order   *list.List // 前端 = 最久未使用
}

func newTTLCache[V any](ttl time.Duration) *ttlCache[V] {
	return &ttlCache[V]{
		ttl:     ttl,
		maxSize: defaultCacheMaxSize,
		items:   make(map[string]*list.Element, 16),
		order:   list.New(),
	}
}

func (c *ttlCache[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var zero V
	el, ok := c.items[key]
	if !ok {
		return zero, false
	}
	entry := el.Value.(*cacheEntry[V])
	if !time.Now().Before(entry.expiresAt) {
		c.order.Remove(el)
		delete(c.items, key)
		return zero, false
	}
	c.order.MoveToBack(el)
	return entry.value, true
}

func (c *ttlCache[V]) Set(key string, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry := &cacheEntry[V]{key: key, value: value, expiresAt: time.Now().Add(c.ttl)}
	if el, ok := c.items[key]; ok {
		el.Value = entry
		c.order.MoveToBack(el)
		return
	}
	c.items[key] = c.order.PushBack(entry)
	for c.order.Len() > c.maxSize {
		oldest := c.order.Front()
		if oldest == nil {
			break
		}
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*cacheEntry[V]).key)
	}
}

func (c *ttlCache[V]) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.order.Remove(el)
		delete(c.items, key)
	}
}
