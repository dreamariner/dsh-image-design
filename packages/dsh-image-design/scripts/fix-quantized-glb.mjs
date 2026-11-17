// 素体资产转换：把 Mixamo 量化 glb 转成「three 能正确解读」的形态。
//
// 背景（2026-11-17 实测事故链）：
//   1) Mixamo 导出的顶点是 int16 量化。glTF 规范里解码公式是
//      f = accessor.min + (v / 32767) * (accessor.max - accessor.min)，
//      而 three 的 GLTFLoader **只按 v / 32767 → [-1,1] 解读，丢掉 min/max 的
//      非对称/非均匀部分** → 几何被压成单位立方体 → 蒙皮整体错位（躯干塌陷）。
//   2) gltf-transform 读入时已按规范解码（POSITION 变 Float32Array，值是真实
//      米级），写回即可让 three 拿到正确几何。
//   3) **必须保持节点层级与 scale 不动**：Mixamo 的网格几何是米级、骨架是厘米级，
//      靠 Armature 的 0.01 与 skin 的 inverseBindMatrices（厘米空间）配对，
//      蒙皮时自动抵消。任何「给网格补 scale」的直觉操作都会破坏这个配对。
//   4) JOINTS_0（骨骼索引）必须保持整型，不能按位置量纲反量化（否则 skinIndex
//      变垃圾值 → skeleton.bones[i] 越界 → 蒙皮计算抛错）。
//
// 用法：node scripts/fix-quantized-glb.mjs <in.glb> <out.glb>

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { weld, prune, dedup } from '@gltf-transform/functions'
import { readFileSync, writeFileSync } from 'node:fs'

const [, , inPath, outPath] = process.argv
if (inPath === undefined || outPath === undefined) {
  console.error('用法：node scripts/fix-quantized-glb.mjs <in.glb> <out.glb>')
  process.exit(1)
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const doc = await io.read(inPath)

// 去掉量化扩展声明（顶点已是 float32，three 不需要 KHR_mesh_quantization）
doc.getRoot().listExtensionsUsed().forEach((e) => {
  if (e.extensionName === 'KHR_mesh_quantization') e.dispose()
})
doc.getRoot().listExtensionsRequired().forEach((e) => {
  if (e.extensionName === 'KHR_mesh_quantization') e.dispose()
})

// 只做几何清理（焊接去重 / 删无用属性），**不改节点层级与 scale**
await doc.transform(dedup(), weld(), prune())

// 自检：位置属性必须是 float32 且是真实尺度（米级），骨骼索引必须保持整型
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')
    const joints = prim.getAttribute('JOINTS_0')
    if (pos !== undefined) {
      const arr = pos.getArray()
      if (!(arr instanceof Float32Array)) throw new Error(`${mesh.getName()} 的 POSITION 不是 float32`)
      const maxY = pos.getMax([])[1]
      if (!(maxY > 1)) throw new Error(`${mesh.getName()} 的 POSITION 量纲异常（maxY=${maxY}，应为米级）`)
    }
    if (joints !== undefined) {
      const arr = joints.getArray()
      if (arr instanceof Float32Array) throw new Error(`${mesh.getName()} 的 JOINTS_0 被写成浮点（骨骼索引会错）`)
    }
  }
}

const out = await io.writeBinary(doc)
writeFileSync(outPath, out)
console.log(`[fix-quantized-glb] ${inPath} (${readFileSync(inPath).length}B) → ${outPath} (${out.length}B)`)
