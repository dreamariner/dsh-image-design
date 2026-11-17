// 拉取 MakeHuman 基础网格（素体人偶的源网格，CC0）。
//
// 出处：https://github.com/makehumancommunity/makehuman
//   commit a8bc2d54ff0ac92e78ff71431b1023eda42bf482（2024-06-26）
//   文件 data/3dobjs/base.obj（文件头写明 2020 年 9 月以 CC0 释出）
// 钉死 commit 是为了可复现：上游随时可能改网格。
//
// 用法：node scripts/fetch-makehuman-base.mjs
// 产物：assets/makehuman-base.obj（随后跑 scripts/build-mannequin-body.mjs 生成 GLB）

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482'
const URL = `https://raw.githubusercontent.com/makehumancommunity/makehuman/${COMMIT}/makehuman/data/3dobjs/base.obj`

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'assets', 'makehuman-base.obj')

if (existsSync(out) && process.argv.includes('--force') === false) {
  console.log(`[fetch] 已存在，跳过：${out}（要重拉加 --force）`)
  process.exit(0)
}

const res = await fetch(URL)
if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${URL}`)
const buf = Buffer.from(await res.arrayBuffer())
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, buf)
console.log(`[fetch] ${buf.length} 字节 → ${out}\n       来源：${URL}`)
