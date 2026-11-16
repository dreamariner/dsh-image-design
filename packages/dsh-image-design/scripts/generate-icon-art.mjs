// 图标美术单源生成器：icon.svg（插件卡片用）→ src/client/generated/icon-art.ts（客户端用）。
//
// 为什么需要它：清单（指南页）条目的图标由宿主渲染，入口是 **React 组件**，
// 而包内 icon.svg 是给 Plugin Manager / Settings 展示的独立资源文件。两者本该
// 是同一套美术，此前是手写两份（漂移风险）。这里让 icon.svg 成为唯一美术源：
//   · 插件卡片：直接读 icon.svg（npm 包内的 ./icon 导出）
//   · 客户端清单：构建期把 icon.svg 的内容生成成 TS 字符串常量，组件以 data URI 渲染
//     （字节级同一份美术，不做 SVG→JSX 的脆弱改写，渐变与描边原样保留）
//
// 生成物入库（提交进 git）：typecheck 在 build 之前跑，源文件必须存在；
// build 每次重生成，测试断言生成物与 icon.svg 逐字节一致（漂移守卫）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = join(pkgDir, 'icon.svg')
const outPath = join(pkgDir, 'src/client/generated/icon-art.ts')

const svg = readFileSync(svgPath, 'utf-8')

const header = `// 自动生成，勿手改：由 scripts/generate-icon-art.mjs 从 icon.svg 生成。
// 美术的唯一真源是包根的 icon.svg；改图形请改 icon.svg 后跑构建（测试会校验两者一致）。

/** icon.svg 的原文（data URI 渲染用，保证与插件卡片同一份美术）。 */
export const ICON_ART_SVG = ${JSON.stringify(svg)}
`

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, header, 'utf-8')
process.stdout.write(`[generate-icon-art] 已生成 ${outPath}（源 ${svgPath}，${svg.length} 字节）\n`)
