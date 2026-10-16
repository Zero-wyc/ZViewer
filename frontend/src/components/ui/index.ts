/**
 * ZViewer 统一 UI 组件库出口。
 *
 * 一键引入所有基础组件：
 *   import { Button, Modal, Tag, SectionHeader, EmptyState } from '@/components/ui'
 *
 * 约定：新页面 / 新功能一律从组件库取用基础 UI 元素，
 * 避免再手写散落的按钮、徽章、区块头、空状态、加载占位等重复实现。
 */

// 基础控件
export { Avatar } from './Avatar'
export { Button } from './Button'
export type { ButtonProps } from './Button'
export { Card } from './Card'
export type { CardProps } from './Card'
export { Dropdown } from './Dropdown'
export type { DropdownOption, DropdownProps } from './Dropdown'
export { FontPickerPanel } from './FontPicker'
export { Form } from './Form'
export type { Rule } from './Form'
export { FullscreenOverlay } from './FullscreenOverlay'
export { Input } from './Input'
export type { InputProps } from './Input'
export { InputNumber } from './InputNumber'
export type { InputNumberProps } from './InputNumber'
export { InputPassword } from './InputPassword'
export type { InputPasswordProps } from './InputPassword'
export { Modal, ConfirmModal } from './Modal'
export type { ModalProps, ConfirmModalProps } from './Modal'
export { RequestNotification } from './RequestNotification'
export type { RequestNotificationItem } from './RequestNotification'
export { SegmentedToggle } from './SegmentedToggle'
export type {
  SegmentedToggleOption,
  SegmentedToggleProps,
} from './SegmentedToggle'
export { Select } from './Select'
export type { SelectOption, SelectProps } from './Select'
export { Slider } from './Slider'
export type { SliderProps } from './Slider'
export { Space } from './Space'
export type { SpaceProps } from './Space'
export { Spinner } from './Spinner'
export type { SpinnerProps } from './Spinner'
export { Switch } from './Switch'
export type { SwitchProps } from './Switch'
export { Tag } from './Tag'
export type { TagProps, TagColor } from './Tag'
export { Title, Text, Paragraph } from './Typography'
export type { TitleProps, TextProps, ParagraphProps } from './Typography'

// 消息反馈
export { message } from './message'
export type { MessageAction } from './message'

// 统合后的通用模式组件
export { SectionHeader } from './SectionHeader'
export type { SectionHeaderProps, SectionHeaderTone } from './SectionHeader'
export { EmptyState } from './EmptyState'
export type { EmptyStateProps } from './EmptyState'
export { LoadingLine } from './LoadingLine'
export type { LoadingLineProps } from './LoadingLine'
export { CopyButton } from './CopyButton'
export type { CopyButtonProps } from './CopyButton'
