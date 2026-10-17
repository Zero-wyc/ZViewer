/** 挂载路径规范化：去空白 + 折叠开头多余斜杠（保留单个前导 /） */
export function normalizeMountPath(path: string): string {
  if (!path) return path
  return path.trim().replace(/^\/+/, '/')
}
