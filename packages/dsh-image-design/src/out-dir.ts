// 产出根目录解析（纯函数，零外部依赖，可单测）。
//
// 为什么单独成文件：src/index.ts 是接线层，它 import 了 typert 协议包（标准装饰器），
// 在 vitest 的 transform 下加载不了，纯函数放在这里才能被单测直接引入。
//
// 目录名约定：工作区分支用点开头的隐藏目录（.image-design）。产出是过程数据，
// 不该和知识资产混在同一层被扫进文档树或 git 跟踪范围。

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 输出目录解析：配置优先（由调用方判断），其次工作区，最后 ~/.dsh 存储区。 */
export function defaultOutDir(workspaceRoot: string | null): string {
  return workspaceRoot !== null ? join(workspaceRoot, '.image-design') : join(homedir(), '.dsh', 'storages', 'dsh-image-design', 'outputs')
}
