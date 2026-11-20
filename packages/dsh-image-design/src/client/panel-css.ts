// 面板与浮层样式（运行期 <style> 注入；第三方插件的 client 构建没有 CSS 管线）。
//
// 规范：只消费 --dsw-alias-* / --dsw-radius-* / --dsw-elevation-* 语义 token，
// 禁字面颜色与主题选择器（dark/light 由宿主 ui-theme 负责）。
//
// dsh-ui-cell 复制件（duc-*）的样式文本拼在本注入器里：顺序按 add note 的依赖序
// （被复用者先注入；复制件的类名共存于同一个 <style>，同特异性规则后者胜）。
// 插件自有类用 idi- 前缀，不与组件类相撞，拼在最后。

// dsh-ui-cell 基础层：间距刻度 --dsh-space-*，组件样式靠它解析，必须排注入第一位
// （0.6.1 复制件起，组件内的间距一律走刻度变量；漏注入 = 那条声明被静默丢弃）
import { styles as foundationStyles } from './ui/foundation-css.ts'
import { styles as sidebarStyles } from './ui/sidebar-css.ts'
import { styles as sidebarNavStyles } from './ui/sidebar-nav-css.ts'
import { styles as buttonStyles } from './ui/button-css.ts'
import { styles as inputStyles } from './ui/input-css.ts'
import { styles as textareaStyles } from './ui/textarea-css.ts'
import { styles as selectStyles } from './ui/select-css.ts'
import { styles as segmentedControlStyles } from './ui/segmented-control-css.ts'
import { styles as switchStyles } from './ui/switch-css.ts'
import { styles as tagStyles } from './ui/tag-css.ts'
import { styles as shortcutKeysStyles } from './ui/shortcut-keys-css.ts'
import { styles as tooltipStyles } from './ui/tooltip-css.ts'
import { styles as spinnerStyles } from './ui/spinner-css.ts'
import { styles as emptyStyles } from './ui/empty-css.ts'
import { styles as imagePreviewStyles } from './ui/image-preview-css.ts'
import { styles as imageLightboxStyles } from './ui/image-lightbox-css.ts'
import { styles as fieldStyles } from './ui/field-css.ts'
import { styles as labelStyles } from './ui/label-css.ts'
import { styles as separatorStyles } from './ui/separator-css.ts'
import { styles as sliderStyles } from './ui/slider-css.ts'

export const PANEL_CSS = `
.idi-root { position: relative; display: flex; flex-direction: row;
  height: 100%; min-width: 0; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1); }

/* 侧栏：duc-sidebar（壳，宽 96px 由 Sidebar 的 width prop 给，收起 48px）+ duc-sidebar-nav（条目），
   header 槽放收起/展开钮，busy 指示放 footer 槽（idi-nav-busy 只管槽内竖排布局）。
   收起钮占满 header 行宽并居中（收起后 header 内容宽只剩 24px，按钮自带 padding 会溢出被裁）。 */
.idi-nav-toggle { width: 100%; justify-content: center; padding: 0; }
.idi-nav-busy { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.idi-nav-busy-text { font-size: 10px; line-height: 14px;
  color: var(--dsw-alias-label-tertiary); white-space: nowrap; }

/* 内容区：错误条浮在顶部，三视图各自吃满剩余高度 */
.idi-content { flex: 1; min-width: 0; min-height: 0; display: flex;
  flex-direction: column; }
.idi-spacer { flex: 1; }

.idi-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 16px;
  display: flex; flex-direction: column; gap: 12px; }

.idi-sec { display: flex; flex-direction: column; gap: 8px; }
.idi-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* 行内按钮不吃挤压：内容区改窄后「生成」主按钮曾被提示词挤成竖排字（2026-11-20 实机） */
.idi-row > .duc-button { flex: none; }
.idi-row-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.idi-grow { flex: 1; min-width: 0; }
.idi-w80 { width: 80px; flex: none; }
.idi-w96 { width: 96px; flex: none; }

.idi-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.idi-error { flex: none; display: flex; gap: 8px; align-items: flex-start; margin: 8px 12px 0;
  padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-state-error-primary); border-radius: var(--dsw-radius-md);
  color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px;
  white-space: pre-wrap; word-break: break-word; }
.idi-error-dismiss { border: none; background: transparent; cursor: pointer;
  color: inherit; font-size: 12px; padding: 0 2px; flex: none; }

.idi-runmeta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.idi-meta { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary);
  word-break: break-all; }
.idi-revised { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto;
  padding: 6px 8px; border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); }
.idi-revised-toggle { border: none; background: transparent; cursor: pointer;
  padding: 0; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary); text-align: left; }
.idi-revised-toggle:hover { color: var(--dsw-alias-label-secondary); }

.idi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px; }
.idi-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 6px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base); }
.idi-cell[data-selected="true"] { border-color: var(--dsw-alias-state-business-primary); }
.idi-cell-head { display: flex; align-items: center; gap: 4px; min-height: 20px; }
.idi-thumb { cursor: zoom-in; border: none; padding: 0; background: transparent; width: 100%; }
.idi-cell-fail { display: flex; align-items: center; justify-content: center;
  height: 120px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-state-error-primary);
  text-align: center; padding: 8px; word-break: break-word; }
.idi-check { accent-color: var(--dsw-alias-state-business-primary); margin: 0; flex: none; }

.idi-hist { display: flex; flex-direction: column; gap: 6px; }
.idi-hist-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  cursor: pointer; background: var(--dsw-alias-bg-base); text-align: left; width: 100%; }
.idi-hist-row:hover { border-color: var(--dsw-alias-state-business-primary); }
.idi-hist-main { display: flex; align-items: center; gap: 6px; min-width: 0; }
.idi-hist-prompt { font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }

.idi-compare { position: absolute; inset: 0; z-index: 20;
  background: var(--dsw-alias-bg-base); display: flex; flex-direction: column; }
.idi-compare-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2); flex: none; }
.idi-compare-body { flex: 1; min-height: 0; display: grid; grid-auto-flow: column;
  grid-auto-columns: minmax(240px, 1fr); overflow: auto; }
.idi-compare-col { display: flex; flex-direction: column; gap: 6px; min-width: 0;
  padding: 8px; border-right: 0.5px solid var(--dsw-alias-border-l2); }
.idi-compare-img { flex: 1; min-height: 160px; display: flex; align-items: center;
  justify-content: center; overflow: auto; }
.idi-compare-img img { max-width: 100%; max-height: 100%; object-fit: contain; }

.idi-reflist { display: flex; flex-direction: column; gap: 6px; }
.idi-refrow { display: flex; gap: 6px; align-items: center; min-width: 0; }

/* ── 素体视图 ──────────────────────────────────────────────────────────── */
/* 布局：视口为主（flex:1 吃掉富余高度），参数区封顶 45% 内部滚动。
   此前视口写死 min(300px, 42vh)，竖向窄栏里站立人体被压成扁宽盒（2026-11-18）。 */
.idi-man-root { flex: 1; min-height: 0; display: flex; flex-direction: column;
  gap: 10px; padding: 10px 12px 16px; }
.idi-man-viewport { flex: 1 1 0; min-height: 300px; position: relative;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  overflow: hidden; background: var(--dsw-alias-bg-base); touch-action: none;
  cursor: grab; }
.idi-man-viewport:active { cursor: grabbing; }
.idi-man-viewport canvas { display: block; outline: none; }
.idi-man-params { flex: none; height: 45%; min-height: 240px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px; }
/* 视口悬浮层：容器不拦截轨道拖拽，子控件各自恢复交互 */
.idi-man-overlay { position: absolute; inset: 0; z-index: 1; pointer-events: none;
  display: flex; flex-direction: column; justify-content: flex-end; }
.idi-man-hint { position: absolute; top: 6px; right: 8px; font-size: 10px; line-height: 14px;
  color: var(--dsw-alias-label-tertiary);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); }
.idi-man-cambar { pointer-events: auto; display: flex; flex-wrap: wrap;
  align-items: center; gap: 6px; margin: 0 8px 8px; padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: color-mix(in srgb, var(--dsw-alias-bg-base) 85%, transparent);
  backdrop-filter: blur(6px); }
/* 姿势下拉限宽：最长选项（A-pose（绑定姿态基准））会把相机条撑到折行 */
.idi-man-cambar select { max-width: 176px; text-overflow: ellipsis; }
/* 拍摄钮独立悬浮（快门钮形态）：窄栏放不进相机条，且独立后相机条稳定单行 */
.idi-man-shutter { position: absolute; right: 12px; bottom: 62px; z-index: 1;
  pointer-events: auto; }
.idi-slider-row { display: flex; align-items: center; gap: 6px; }
/* 滑杆防轨道跳值不在 CSS 做：pointer-events:none 在 Chromium 里连 thumb 伪元素
   一起禁死（::-webkit-slider-thumb 的 pointer-events:auto 不生效），实机验证
   拖 thumb 也失效。JS 方案在 MannequinView 的 mousedown 命中测试。 */
.idi-slider-label { flex: none; width: 58px; font-size: 11px; line-height: 16px;
  color: var(--dsw-alias-label-secondary); }
.idi-slider-val { flex: none; min-width: 48px; text-align: right; font-size: 11px;
  line-height: 16px; color: var(--dsw-alias-label-tertiary);
  font-variant-numeric: tabular-nums; }
.idi-ref-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base); min-width: 0; }
.idi-ref-thumb { width: 44px; height: 44px; flex: none; object-fit: cover;
  border-radius: var(--dsw-radius-sm); border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); }
.idi-ref-meta { flex: 1; min-width: 0; display: flex; flex-direction: column;
  gap: 2px; overflow: hidden; }
/* 折叠分组（测量/雕刻/脸/手），原生 details 承载 */
.idi-fold { border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-base); overflow: hidden; }
.idi-fold > summary { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary);
  cursor: pointer; user-select: none; list-style: none; }
.idi-fold > summary::-webkit-details-marker { display: none; }
.idi-fold > summary::before { content: '›'; display: inline-block; width: 10px;
  font-size: 14px; line-height: 10px; color: var(--dsw-alias-label-tertiary);
  transition: transform 0.15s ease; }
.idi-fold[open] > summary::before { transform: rotate(90deg); }
.idi-fold[open] > summary { border-bottom: 0.5px solid var(--dsw-alias-border-l3); }
.idi-fold > .idi-slider-row { padding: 4px 8px; }
.idi-fold > .idi-slider-row:last-child { padding-bottom: 8px; }
/* 资产加载遮罩 */
.idi-man-loading { position: absolute; inset: 0; z-index: 2; display: flex;
  flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-base); }
`

/* 0.6.1 升级：照 add note 的依赖序重排（foundation 第一）。
 * menu / menu-group / menu-surface / toast / card / scroll-area / skeleton /
 * zoom-controls 是闭包带出的未用复制件（0 处引用），维持不接线。
 * 007/008 迭代补复制 sidebar + sidebar-nav（issue 008 迁移侧栏导航），按 add note
 * 依赖序紧随 foundation（无其他复制件依赖它们，也不依赖别件）。 */
const CELL_STYLES = [
  foundationStyles,
  sidebarStyles, sidebarNavStyles,
  buttonStyles, emptyStyles, fieldStyles, imagePreviewStyles, imageLightboxStyles,
  inputStyles, labelStyles, shortcutKeysStyles, tooltipStyles,
  segmentedControlStyles, selectStyles, separatorStyles, sliderStyles,
  spinnerStyles, switchStyles, tagStyles, textareaStyles,
]

export function injectPanelStyles(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = '@dreamariner/dsh-image-design'
  tag.dataset.pluginCss = '@dreamariner/dsh-image-design/panel.css'
  tag.textContent = [PANEL_CSS, ...CELL_STYLES].join('\n')
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
