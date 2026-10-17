import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { SingleLineInput } from './shared'

interface ServerFilesSourceFormProps {
  path: string
  onChangePath: (value: string) => void
  onOpenBrowser: () => void
  onAdd: () => void
}

/** 服务器文件来源：浏览器选择 + 手动输入路径（均支持多选批量添加） */
export function ServerFilesSourceForm({
  path,
  onChangePath,
  onOpenBrowser,
  onAdd,
}: ServerFilesSourceFormProps) {
  return (
    <Space direction="vertical" className="w-full" size="sm">
      <Button
        variant="secondary"
        size="sm"
        icon={<FolderOpen className="h-4 w-4" />}
        onClick={onOpenBrowser}
      >
        浏览服务器文件
      </Button>
      <SingleLineInput
        value={path}
        onChange={onChangePath}
        placeholder="手动输入路径，或点击上方按钮浏览选择（支持多选批量添加）"
        onEnter={onAdd}
      />
    </Space>
  )
}
