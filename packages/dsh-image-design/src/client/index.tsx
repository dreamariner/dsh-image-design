// @dreamariner/dsh-image-design :: 浏览器半边入口
//
// 官方形态（DSH skill cordis-plugin-development 的 templates/decoration/client.js）：
//   · 产物 lib/client.js 被 tsdown.config.ts 包上 window.__ModuleLoader__.load({...})
//     的 CJS 包装；factory 返回 { inject, apply } : 与 host 插件同构的 cordis 接口；
//   · react 来自宿主渲染进程模块表（构建时 EXTERNALS 外置），不打包、不 CDN、不自装。
//
// ⚠ 官方 practices（违反会坏或难看，逐条对照）：
//   · 不 require 任何 @deepseek-ai/dsh-client-* 包 : 清单随时可能变，也不在你的
//     模块表请求里；控件用 dsh-ui-cell 复制件，样式只引用 --dsw-alias-* 主题 token；
//   · 不往 document.body 追加节点（lightbox 的 body portal 是复制件自带行为）、
//     不替换应用根、不读别的插件的 DOM；
//   · 槽位选「已分配空间」的（sidebar.right.pane.tab / conversation.composer.dock）；
//   · 定时器 / 监听 / 样式等资源在 ctx.effect 里注册并返回清理函数。
//
// 面：右栏 tab（面板本体）+ 输入框下方入口徽标。Remote 走 typert 生成的
// $mount（lib/typert.remote-client.js），不能从 src/remote.ts 值导入：那会把
// typert-protocol 的值依赖拖进浏览器 bundle → web boot: 1 entry did not activate。

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { TYPERT_REMOTE } from '@dreamariner/dsh-image-design/remote'
import { injectPanelStyles } from './panel-css.ts'
import { createImageDesignApi, type ImageDesignApi } from './api.ts'
import { ImageDesignPanel } from './App.tsx'
import { DockEntry } from './DockEntry.tsx'

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote']

/** 本插件用到的 slots 服务面（窄化：只声明用到的成员）。 */
interface SlotsService {
  inject(ownerKey: string, register: () => void): void
  register(options: {
    name: string
    /** pane 槽位用 key（对应 tab 的 id）；dock 槽位用 id。 */
    key?: string
    id?: string
    order?: number
    /** 注入给组件的 props（装配层闭包 → 组件）。 */
    inject?: () => unknown
  }, component: unknown): void
}

/** sidebarRightTabs 的窄化面：tab 类型注册（patterns 决定资源自动打开，空 = 只能显式打开）。 */
interface SidebarRightTabsService {
  register(def: {
    id: string
    kind: string
    patterns: readonly string[]
    priority: 'fallback' | 'primary'
    keepMounted?: boolean
    title: () => string
  }): void
}

interface SidebarRightService {
  openTab(kind: string): void
}

interface RemoteService {
  $mount(remote: unknown): Promise<() => void>
}

interface ClientContext {
  slots?: SlotsService
  sidebarRightTabs?: SidebarRightTabsService
  sidebarRight?: SidebarRightService
  remote?: RemoteService
  effect(fn: () => void | (() => void), name: string): void
  inject(services: readonly string[], cb: (scoped: { remote: Record<string, unknown>; sidebarRight: SidebarRightService }) => void): void
}

const KIND = 'image-design:panel'
const TAB_ID = 'image-design'
const PLUGIN = 'dsh-image-design'

export function apply(rawCtx: unknown): void {
  const ctx = rawCtx as ClientContext
  // 收窄成局部量并逐个检查（宁可装载失败也不要静默）：漏声明的 service 这里就会炸
  const { slots, sidebarRightTabs, sidebarRight, remote } = ctx
  if (slots === undefined) throw new Error(`[${PLUGIN}] ctx.slots 不可用:inject 白名单声明与宿主实际提供的服务不一致`)
  if (sidebarRightTabs === undefined) throw new Error(`[${PLUGIN}] ctx.sidebarRightTabs 不可用:inject 白名单声明与宿主实际提供的服务不一致`)
  if (sidebarRight === undefined) throw new Error(`[${PLUGIN}] ctx.sidebarRight 不可用:inject 白名单声明与宿主实际提供的服务不一致`)
  if (remote === undefined) throw new Error(`[${PLUGIN}] ctx.remote 不可用:inject 白名单声明与宿主实际提供的服务不一致`)

  ctx.effect(() => injectPanelStyles(), `${PLUGIN}: panel styles`)

  // $mount 与 inject 的顺序：mount 先行（不阻塞），scoped 注入在命名空间就绪后回调
  const mounted = remote.$mount(TYPERT_REMOTE)
    .then((dispose) => { ctx.effect(() => dispose, `${PLUGIN}: unmount remote`); return dispose })
    .catch((error: unknown) => { console.error(`[${PLUGIN}] $mount 失败`, error) })

  ctx.inject(['remote.imageDesign', 'sidebarRight'], (scoped) => {
    void mounted
    const api = createImageDesignApi(scoped.remote.imageDesign as unknown)
    const open = (): void => { scoped.sidebarRight.openTab(KIND) }

    ctx.effect(() => sidebarRightTabs.register({
      id: TAB_ID,
      kind: KIND,
      patterns: [],
      priority: 'fallback',
      keepMounted: true,
      title: () => '图片设计',
    }), `${PLUGIN}: tab type`)

    slots.inject('sidebar.right.pane.tab', () => slots.register(
      { name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ api }) },
      // slot 组件签名由宿主裁定（inject() props），与 ImageDesignPanel 的 api prop 对齐
      ImageDesignPanel,
    ))

    slots.inject('conversation.composer.dock', () => slots.register(
      { name: 'conversation.composer.dock', id: `${PLUGIN}-entry`, order: 6, inject: () => ({ open }) },
      DockEntry,
    ))
  })
}
