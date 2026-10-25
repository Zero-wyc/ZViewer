package cms

import (
	"zviewer/backend/internal/ttlcache"
)

// resolveCache 是 CMS 解析结果缓存的薄封装。
//
// 真正的实现在 internal/ttlcache：anisubs 的 /resolve 用同一套「TTL + 单飞 +
// 容量淘汰」语义，两份拷贝迟早会漂，抽出去共用。

// resolveCache 对应 utils/resolve-cache.ts 的 ResolveCache。
type resolveCache[T any] struct {
	cache *ttlcache.Cache[T]
}

func newResolveCache[T any](ttlMs int64, maxSize int) *resolveCache[T] {
	return &resolveCache[T]{cache: ttlcache.New[T](ttlMs, maxSize)}
}

// run 命中直接返回；未命中执行 fn 并写入缓存；并发同 key 折叠为一次执行。
func (c *resolveCache[T]) run(key string, fn func() (T, error)) (T, error) {
	return c.cache.Run(key, fn)
}
