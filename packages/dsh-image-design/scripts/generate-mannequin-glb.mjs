// 素体模型内联生成器：assets/mannequin-body.glb（真人素体，1.19MB）
// → src/client/generated/mannequin-glb.ts（base64 字符串模块）。
//
// 为什么内联：DSH 的 client 产物是单文件 CJS（lib/client.js），运行期没有可靠的
// 相对资源 URL；模型作为 base64 常量进 bundle，GLTFLoader.parse 直接吃字节。
//
// 模型出处（对外署名见 README）：assets/mannequin-body.glb 由
// scripts/build-mannequin-body.mjs 从 MakeHuman 基础网格（CC0）生成：
// MakeHuman base mesh hm08 + 自建 28 骨骨架 + 蒙皮权重。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'assets', 'mannequin-body.glb')
const out = join(here, '..', 'src', 'client', 'generated', 'mannequin-glb.ts')

const bytes = readFileSync(src)
const b64 = bytes.toString('base64')

const header = `// 自动生成，勿手改（node scripts/generate-mannequin-glb.mjs）。
// 内容：assets/mannequin-body.glb 的 base64（真人素体：MakeHuman 基础网格 CC0 +
// 自建骨架蒙皮，由 scripts/build-mannequin-body.mjs 生成）。GLTFLoader.parse 解码。

/** 素体 GLB 的 base64 字节（Uint8Array 由调用方 atob 得到，本文件只存字符串）。 */
export const MANNEQUIN_GLB_BASE64 = '${b64}'
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, header)
console.log(`[generate-mannequin-glb] ${bytes.length} bytes → ${out} (${(b64.length / 1024).toFixed(0)}KB b64)`)
