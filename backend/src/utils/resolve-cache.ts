/**
 * 解析结果缓存 + 单飞去重（resolve 层通用基建）。
 *
 * 用于 /xxx/resolve 类端点：解析通常意味着抓源站页面/打上游 API，
 * 多人同时进房间播同一集时会重复触发；短 TTL 缓存让窗口内共享结果，
 * inflight 合并把并发请求折叠为一次上游解析。失败结果不缓存
 * （promise 拒绝传播给所有等待者后即从 inflight 移除，下次重试）。
 */

/** 稳定字符串化：键按字典序排序，消除客户端发送顺序差异 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

interface CacheEntry<V> {
  value: V;
  fetchedAt: number;
}

export class ResolveCache<V> {
  private cache = new Map<string, CacheEntry<V>>();
  private inflight = new Map<string, Promise<V>>();

  constructor(
    private readonly ttlMs: number,
    /** 容量上限：超限按插入序淘汰最旧条目（防无界增长） */
    private readonly maxSize = 500,
  ) {}

  /** 命中返回缓存值；未命中执行 fn 并写入缓存；并发同 key 折叠为同一次执行。 */
  async run(key: string, fn: () => Promise<V>): Promise<V> {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.value;
    }
    if (cached) {
      this.cache.delete(key);
    }

    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const promise = fn()
      .then((value) => {
        // 容量淘汰：Map 迭代序即插入序
        if (this.cache.size >= this.maxSize) {
          const oldest = this.cache.keys().next();
          if (!oldest.done) {
            this.cache.delete(oldest.value);
          }
        }
        this.cache.set(key, { value, fetchedAt: Date.now() });
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  /** 全量失效（数据源配置变更等场景） */
  clear(): void {
    this.cache.clear();
  }
}
