// 图片设计在空会话首页的入口 chip：新会话控制行（工作区 / 预设档同排）右对齐位。
// 组件接收宿主 slot 的 inject() props（open 由装配层闭包注入）。

import type { ReactNode } from 'react'
import { Button } from './ui/button.tsx'

export function HeroEntry({ open }: { open: () => void }): ReactNode {
  return (
    <Button variant="outline" size="sm" onClick={open} aria-label="打开图片设计面板">
      图片设计
    </Button>
  )
}
