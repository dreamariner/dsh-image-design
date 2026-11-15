// 图片设计在输入框下方的入口徽标：点一下打开右栏的「图片设计」tab。
// 组件接收宿主 slot 的 inject() props（open 由装配层闭包注入）。

import type { ReactNode } from 'react'
import { Button } from './ui/button.tsx'

export function DockEntry({ open }: { open: () => void }): ReactNode {
  return (
    <Button variant="ghost" onClick={open} aria-label="打开图片设计面板">
      图片设计
    </Button>
  )
}
