// 拉取 MakeHuman 的 morph target + 测量定义（精确素体的源数据，CC0）。
//
// 出处：https://github.com/makehumancommunity/makehuman
//   commit a8bc2d54ff0ac92e78ff71431b1023eda42bf482（与 base.obj 同 commit，顶点索引才对齐）
//   data/targets/**/*.target  CC0
//   data/modifiers/measurement_modifiers.json  CC0
//   plugins/0_modeling_a_measurement.py  CC0（提取 Ruler 顶点环）
//
// 精选清单：20 项测量（incr/decr 各一）+ 身体/脸/手部位雕刻 ~60 个。
// 不拉全量 1280 个（体积失控），只拉对「精确身材 + 个体特征」有辨识度的。
// 左右成对的部位只写 l- 侧，脚本自动补拉同名 r-（MakeHuman 的对称 modifier 就是
// l/r 两个 target 同权重；运行时 applyPreciseShape 对 l- 名自动补 r-，见 shape3.ts）。
// 产物：assets/morphs-src/（源文件 + manifest 输入），随后跑 build-mannequin-morphs.mjs。

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMMIT = 'a8bc2d54ff0ac92e78ff71431b1023eda42bf482'
const RAW = `https://raw.githubusercontent.com/makehumancommunity/makehuman/${COMMIT}`
const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'assets', 'morphs-src')

// 20 项测量（对应 measurement_modifiers.json 的 target 名）
const MEASURES = [
  'neck-circ', 'neck-height', 'upperarm-circ', 'upperarm-length', 'lowerarm-length',
  'wrist-circ', 'frontchest-dist', 'bust-circ', 'underbust-circ', 'waist-circ',
  'napetowaist-dist', 'waisttohip-dist', 'shoulder-dist', 'hips-circ', 'upperleg-height',
  'thigh-circ', 'lowerleg-height', 'calf-circ', 'knee-circ', 'ankle-circ',
]

// 部位雕刻：全部为 MakeHuman 上游真实存在的文件名（已逐个核对）。
// 覆盖身体 + 脸 + 手关键解剖点；incr/decr 成对做双向滑杆。
const SCULPT = [
  // 宏观体型（女/男各若干轮廓）
  'bodyshapes/bodyshapes-elvs-fem-apple', 'bodyshapes/bodyshapes-elvs-fem-triangle',
  'bodyshapes/bodyshapes-elvs-fem-neat-hourglass', 'bodyshapes/bodyshapes-elvs-fem-rectangle',
  'bodyshapes/bodyshapes-elvs-man-apple', 'bodyshapes/bodyshapes-elvs-man-trapezoid',
  'bodyshapes/bodyshapes-elvs-man-triangle', 'bodyshapes/bodyshapes-elvs-man-rectangle',
  // 胸/臀/髋
  'breast/breast-dist-incr', 'breast/breast-dist-decr',
  'breast/breast-volume-vert-up', 'breast/breast-volume-vert-down',
  // 乳房通用雕刻：尖挺 / 上提下垂 / 乳头（女性形态的关键形状维度，不是围度）
  'breast/breast-point-incr', 'breast/breast-point-decr',
  'breast/breast-trans-up', 'breast/breast-trans-down',
  'breast/nipple-size-incr', 'breast/nipple-size-decr',
  'breast/nipple-point-incr', 'breast/nipple-point-decr',
  'buttocks/buttocks-volume-incr', 'buttocks/buttocks-volume-decr',
  'hip/hip-scale-horiz-incr', 'hip/hip-scale-horiz-decr',
  'hip/hip-scale-depth-incr', 'hip/hip-scale-depth-decr',
  'hip/hip-scale-vert-incr', 'hip/hip-scale-vert-decr',
  // 躯干/腹/骨盆
  'stomach/stomach-tone-incr', 'stomach/stomach-tone-decr',
  'stomach/stomach-pregnant-incr',
  'torso/torso-scale-horiz-incr', 'torso/torso-scale-horiz-decr',
  'torso/torso-muscle-pectoral-incr', 'torso/torso-muscle-pectoral-decr',
  'torso/torso-vshape-incr', 'torso/torso-vshape-decr',
  'pelvis/pelvis-tone-incr', 'pelvis/pelvis-tone-decr',
  // 四肢肌肉/脂肪（左右成对的只写 l- 侧，下方自动补拉 r-）
  'armslegs/l-lowerarm-muscle-incr', 'armslegs/l-lowerarm-muscle-decr',
  'armslegs/l-lowerarm-fat-incr', 'armslegs/l-lowerarm-fat-decr',
  'armslegs/l-upperarm-muscle-incr', 'armslegs/l-upperarm-muscle-decr',
  'armslegs/l-upperleg-muscle-incr', 'armslegs/l-upperleg-muscle-decr',
  'armslegs/l-lowerleg-muscle-incr', 'armslegs/l-lowerleg-muscle-decr',
  'armslegs/l-leg-valgus-incr', 'armslegs/l-leg-valgus-decr',
  // 手（指长/指粗/手尺寸）
  'armslegs/l-hand-fingers-length-incr', 'armslegs/l-hand-fingers-length-decr',
  'armslegs/l-hand-fingers-diameter-incr', 'armslegs/l-hand-fingers-diameter-decr',
  'armslegs/l-hand-scale-incr', 'armslegs/l-hand-scale-decr',
  // 脸型
  'head/head-age-incr', 'head/head-age-decr',
  'head/head-fat-incr', 'head/head-fat-decr',
  'head/head-scale-horiz-incr', 'head/head-scale-horiz-decr',
  'head/head-scale-depth-incr', 'head/head-scale-depth-decr',
  'head/head-scale-vert-incr', 'head/head-scale-vert-decr',
  'head/head-square', 'head/head-round', 'head/head-oval',
  'chin/chin-height-incr', 'chin/chin-height-decr',
  'chin/chin-width-incr', 'chin/chin-width-decr',
  'chin/chin-prominent-incr', 'chin/chin-prominent-decr',
  'cheek/l-cheek-bones-incr', 'cheek/l-cheek-bones-decr',
  'cheek/l-cheek-volume-incr', 'cheek/l-cheek-volume-decr',
  'forehead/forehead-scale-vert-incr', 'forehead/forehead-scale-vert-decr',
  'forehead/forehead-temple-incr', 'forehead/forehead-temple-decr',
  // 鼻
  'nose/nose-base-up', 'nose/nose-base-down',
  'nose/nose-flaring-incr', 'nose/nose-flaring-decr',
  'nose/nose-hump-incr', 'nose/nose-hump-decr',
  'nose/nose-scale-vert-incr', 'nose/nose-scale-vert-decr',
  'nose/nose-scale-horiz-incr', 'nose/nose-scale-horiz-decr',
  // 眼/眉/嘴/耳/颈
  'eyes/l-eye-scale-incr', 'eyes/l-eye-scale-decr',
  'eyebrows/eyebrows-angle-up', 'eyebrows/eyebrows-angle-down',
  'mouth/mouth-scale-horiz-incr', 'mouth/mouth-scale-horiz-decr',
  'mouth/mouth-lowerlip-volume-incr', 'mouth/mouth-lowerlip-volume-decr',
  'ears/l-ear-scale-incr', 'ears/l-ear-scale-decr',
  'neck/neck-scale-horiz-incr', 'neck/neck-scale-horiz-decr',
  'neck/neck-double-incr', 'neck/neck-double-decr',
]

const targets = []
for (const m of MEASURES) {
  targets.push(`targets/measure/measure-${m}-incr.target`)
  targets.push(`targets/measure/measure-${m}-decr.target`)
}
for (const s of SCULPT) targets.push(`targets/${s}.target`)
// 左右成对补拉：SCULPT 里每个 l- 都有同名 r-（缺一个都会让该滑杆只作用单侧，
// 2026-11-17 审计实测 l-upperarm 等全是单边顶点）。
const MIRRORED = SCULPT.filter((s) => /\/l-/.test(s)).map((s) => s.replace('/l-', '/r-'))
for (const s of MIRRORED) targets.push(`targets/${s}.target`)

// 性别基：HM08 base 是中性体。注意 macrodetails/universal-* 是 604 字节的空占位文件
// （只有注释、零位移），真正带位移的是 {race}-{gender}-{age} 这一族（~400KB 密集）。
// 取 caucasian-{female,male}-young 作两端，性别在两者之间线性插值；年龄固定青年，
// 肌肉/体重/年龄感仍由既有 sculpt morph 叠加。
const GENDER_BASE = [
  'macrodetails/caucasian-female-young',
  'macrodetails/caucasian-male-young',
]
for (const g of GENDER_BASE) targets.push(`targets/${g}.target`)

// 乳房形态：MakeHuman 的 cup × firmness 二维档位（young + average 体格）。
// cup 决定容积/前突，firmness 决定集中度与下垂——这两个才是「女性胸型」的本体，
// measure-bust-circ 只改整体围度，做不出形状。
const CUPS = ['mincup', 'averagecup', 'maxcup']
const FIRMNESS = ['minfirmness', 'averagefirmness', 'maxfirmness']
for (const c of CUPS) {
  for (const f of FIRMNESS) {
    // 上游没有 averagecup-averagefirmness（它就是零位移基准），缺这个组合即代表中性
    if (c === 'averagecup' && f === 'averagefirmness') continue
    targets.push(`targets/breast/female-young-averagemuscle-averageweight-${c}-${f}.target`)
  }
}

const extra = [
  'modifiers/measurement_modifiers.json',
  'modifiers/measurement_sliders.json',
]

async function fetchOne(relPath, outPath) {
  if (existsSync(outPath)) return { relPath, bytes: null, cached: true }
  const url = `${RAW}/makehuman/data/${relPath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, buf)
  return { relPath, bytes: buf.length, cached: false }
}

console.log(`[fetch-morphs] ${targets.length} 个 target + ${extra.length} 个定义文件，commit ${COMMIT.slice(0, 8)}`)
let ok = 0
const missing = []
for (const rel of [...targets, ...extra]) {
  const name = rel.replace(/^targets\//, '').replace(/\.target$/, '')
  try {
    const r = await fetchOne(rel, join(outDir, rel.replace('targets/', 'target/')))
    ok++
    if (!r.cached) process.stdout.write('.')
  } catch (e) {
    missing.push({ rel, err: String(e) })
    process.stdout.write('X')
  }
}
// Ruler 顶点环：从 plugin py 提取（整文件拉下来，build 脚本解析）
try {
  const py = 'plugins/0_modeling_a_measurement.py'
  const res = await fetch(`${RAW}/makehuman/${py}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  writeFileSync(join(outDir, 'measurement-ruler.py'), Buffer.from(await res.arrayBuffer()))
  ok++
  process.stdout.write('.')
} catch (e) {
  missing.push({ rel: 'measurement-ruler.py', err: String(e) })
  process.stdout.write('X')
}
console.log(`\n[fetch-morphs] 完成 ${ok}/${targets.length + extra.length + 1}`)
if (missing.length > 0) {
  console.error('以下文件缺失（target 名可能与上游不符，需从清单移除或改名）：')
  for (const m of missing) console.error(`  ${m.rel}: ${m.err}`)
  process.exitCode = 1
}
