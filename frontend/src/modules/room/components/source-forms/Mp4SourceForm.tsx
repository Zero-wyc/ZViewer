import { SingleLineInput } from './shared'

interface Mp4SourceFormProps {
  url: string
  onChangeUrl: (value: string) => void
  /** 回车添加 */
  onAdd: () => void
}

/** 视频直链来源：单行地址输入 */
export function Mp4SourceForm({ url, onChangeUrl, onAdd }: Mp4SourceFormProps) {
  return (
    <SingleLineInput
      value={url}
      onChange={onChangeUrl}
      placeholder="MP4/WebM 等视频直链"
      onEnter={onAdd}
    />
  )
}
