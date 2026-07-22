import { DanmakuSourceProvider } from './types';
import { bilibiliVideoDanmakuProvider } from './providers/bilibiliVideo';
import { bahamutDanmakuProvider } from './providers/bahamut';
import { dandanplayDanmakuProvider } from './providers/dandanplay';

export * from './types';

export const danmakuProviders: Record<string, DanmakuSourceProvider> = {
  bilibili: bilibiliVideoDanmakuProvider,
  bahamut: bahamutDanmakuProvider,
  dandanplay: dandanplayDanmakuProvider,
};

export function getDanmakuProvider(source: string): DanmakuSourceProvider | undefined {
  return danmakuProviders[source];
}

export function listDanmakuSources(): Array<{ id: string; name: string }> {
  return Object.entries(danmakuProviders).map(([id, provider]) => ({
    id,
    name: provider.name,
  }));
}
