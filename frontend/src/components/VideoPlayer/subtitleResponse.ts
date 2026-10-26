/** Validate the complete response before replacing or broadcasting any tracks. */
export async function readSubtitleLoadResponse(response: Response): Promise<{ content: string; filename: string; format: string }> {
 const data = await response.json() as { success?: boolean; content?: string; filename?: string; format?: string; message?: string; code?: string }
 if (response.status === 413 || data.code === 'SUBTITLE_TOO_LARGE') throw new Error('字幕文件不能超过 2 MiB，请选择较小的字幕')
 if (!response.ok || !data.success || !data.content) throw new Error(data.message || '加载字幕失败')
 if (new TextEncoder().encode(data.content).byteLength > 2 * 1024 * 1024) throw new Error('字幕文件不能超过 2 MiB，请选择较小的字幕')
 const format = (data.format || 'srt').toLowerCase()
 if (!['vtt', 'srt', 'ass', 'ssa', 'smi', 'sami', 'sub'].includes(format)) throw new Error('不支持的字幕格式')
 return { content: data.content, filename: data.filename || '', format }
}
