// 统一挂载聚合 API：合并 webdav/openlist/ftp 三个独立模块的挂载列表
// 各模块保持独立 CRUD，本模块仅提供聚合读取能力供个人中心和推送面板使用
import { getWebDAVMounts } from '@/modules/webdav/webdavApi'
import { getOpenListMounts } from '@/modules/openlist/openlistApi'
import { getFTPMounts } from '@/modules/ftp/ftpApi'
import type { UnionMount } from './types'

/**
 * 获取当前用户的所有挂载（聚合 webdav/openlist/ftp）
 * 任一模块失败时记录错误但不影响其他模块返回
 */
export async function fetchAllMounts(): Promise<UnionMount[]> {
  const results = await Promise.allSettled([
    getWebDAVMounts(),
    getOpenListMounts(),
    getFTPMounts(),
  ])

  const mounts: UnionMount[] = []
  const errors: string[] = []

  results.forEach((result, index) => {
    const type = ['webdav', 'openlist', 'ftp'][index]
    if (result.status === 'fulfilled') {
      mounts.push(...result.value)
    } else {
      const msg =
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason)
      errors.push(`${type}: ${msg}`)
      console.error(`[mounts] fetch ${type} mounts failed:`, result.reason)
    }
  })

  if (errors.length > 0 && mounts.length === 0) {
    throw new Error(`获取挂载列表失败：${errors.join('; ')}`)
  }

  // 按创建时间倒序
  mounts.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )
  return mounts
}
