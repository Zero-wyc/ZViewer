/**
 * OBS 推流密钥生成工具。
 */

import crypto from 'crypto';

/**
 * 生成一个适合作为 OBS 推流码的随机字符串。
 *
 * - 长度 8 位，包含大小写字母和数字
 * - 排除易混淆字符（0, O, I, l, 1）
 * - 同一 roomId 重复调用会生成不同结果
 */
export function generateStreamKey(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let key = '';
  for (const byte of bytes) {
    key += chars[byte % chars.length];
  }
  return key;
}
