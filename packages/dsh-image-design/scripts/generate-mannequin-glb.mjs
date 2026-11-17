// 素体模型内联生成器：assets/xbot.glb（Mixamo 灰模人偶，已精确反量化，2.64MB）
// → src/client/generated/mannequin-glb.ts（base64 字符串模块）。
//
// 为什么内联：DSH 的 client 产物是单文件 CJS（lib/client.js），运行期没有可靠的
// 相对资源 URL；模型作为 base64 常量进 bundle，GLTFLoader.parse 直接吃字节。
//
// 模型出处（对外署名见 README）：Xbot.glb 取自 three.js 官方示例资源
// （github.com/mrdoob/three.js，MIT 仓库），原始模型作者 Mixamo（Mixamo X Bot 灰模）。
// ⚠ 必须先经 scripts/fix-quantized-glb.mjs 精确反量化：Mixamo 导出的顶点是 int16
//   量化，three 只按 ±1 归一化解读，会把几何压扁、蒙皮整体错位。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, '..', 'assets', 'xbot.glb')
const out = join(here, '..', 'src', 'client', 'generated', 'mannequin-glb.ts')

const bytes = readFileSync(src)
const b64 = bytes.toString('base64')

const header = `// 自动生成，勿手改（node scripts/generate-mannequin-glb.mjs）。
// 内容：assets/xbot.glb 的 base64（Mixamo 灰模人偶，three.js 示例资源，原始作者 Mixamo；
// 已精确反量化）。GLTFLoader.parse 解码。

/** 素体 GLB 的 base64 字节（Uint8Array 由调用方 atob 得到，本文件只存字符串）。 */
export const MANNEQUIN_GLB_BASE64 = '${b64}'
`

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, header)
console.log(`[generate-mannequin-glb] ${bytes.length} bytes → ${out} (${(b64.length / 1024).toFixed(0)}KB b64)`)
