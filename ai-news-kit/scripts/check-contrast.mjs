#!/usr/bin/env node
/**
 * 对比度门禁（WCAG 2.1 AA）
 *
 * 为什么要它：PPT 的配色是否达标，肉眼判断不可靠（尤其琥珀/中灰这类"看起来还行"的颜色）。
 * 本脚本从 build-pptx.mjs 源码里抽取颜色常量（单一真相源，避免两处维护），
 * 逐个计算前景/背景对比度，不达标即 exit 1 —— 可以挂进 CI 或 pre-commit。
 *
 * 判据（WCAG 2.1 AA）：
 *   普通文字（< 18pt，或 < 14pt 粗体）  ≥ 4.5:1
 *   大字（≥ 18pt，或 ≥ 14pt 粗体）      ≥ 3:1
 *   图形 / UI 元素                      ≥ 3:1
 *
 * 用法：node scripts/check-contrast.mjs [--brief]  (--brief 打印全部组合，默认只打印违规)
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, 'build-pptx.mjs')

const VERBOSE = process.argv.includes('--brief')

/** 从源码里抽出一个 `const NAME = { ... }` 对象字面量并求值。 */
function extractObject(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\{`)
  const m = re.exec(src)
  if (!m) throw new Error(`build-pptx.mjs 里找不到 const ${name}`)
  let i = m.index + m[0].length - 1
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${src.slice(i, j + 1)})`)()
      }
    }
  }
  throw new Error(`const ${name} 的对象字面量没有闭合`)
}

/** sRGB 相对亮度（WCAG 定义） */
function relLum(hex) {
  const h = hex.replace('#', '')
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/** 对比度 (L1 + 0.05) / (L2 + 0.05) */
function contrast(a, b) {
  const [x, y] = [relLum(a), relLum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const src = await readFile(SRC, 'utf8')
const C = extractObject(src, 'C')
const LV = extractObject(src, 'LV')
const WHITE = 'FFFFFF'

// 用途登记：颜色 → 它实际出现的位置与字号。字号决定套 4.5 还是 3 的阈值。
// 这份清单必须与 build-pptx.mjs 同步；改版式时一并更新。
const USES = [
  { color: C.ink,    bg: WHITE, pt: 11,   where: '正文 / 事件 / keyFacts 主文字' },
  { color: C.ink,    bg: WHITE, pt: 9.5,  where: 'keyFacts 列表（最小正文）' },
  { color: C.sub,    bg: WHITE, pt: 9,    where: '来源行 / 统计条' },
  { color: C.faint,  bg: WHITE, pt: 9,    where: '页脚 / 页码 / 免责小字' },
  { color: C.faint,  bg: WHITE, pt: 10,   where: '"要闻 N/M" / 卡片单位 / 扫读说明' },
  { color: C.brand,  bg: WHITE, pt: 11,   where: 'kicker / "事件"标签' },
  { color: C.coding, bg: WHITE, pt: 12,   where: '"为什么值得关注"标题' },
  { color: C.embodied, bg: WHITE, pt: 12, where: '"为什么值得关注"标题（具身）' },
  ...Object.entries(LV).map(([k, v]) => ({ color: WHITE, bg: v, pt: 11, where: `置信度 pill「${k}」白字` })),
  { color: WHITE, bg: C.coding,   pt: 10, where: 'topic pill「AI Coding」白字' },
  { color: WHITE, bg: C.embodied, pt: 10, where: 'topic pill「具身智能」白字' },
]

const rows = []
for (const u of USES) {
  const ratio = contrast(u.color, u.bg)
  const large = u.pt >= 18 || (u.pt >= 14) // 粗体门槛按 14pt 保守取
  const min = large ? 3 : 4.5
  rows.push({ ...u, ratio, min, pass: ratio >= min })
}

const bad = rows.filter((r) => !r.pass)
const show = VERBOSE ? rows : bad

console.log(`[check-contrast] 来源：${SRC}`)
console.log(`[check-contrast] 检查 ${rows.length} 个前景/背景组合，WCAG 2.1 AA`)
console.log('')
console.log('  对比度   阈值   前景      背景      位置')
console.log('  ------   ----   -------   -------   --------------------------------')
for (const r of show.sort((a, b) => a.ratio - b.ratio)) {
  console.log(
    `  ${r.ratio.toFixed(2).padStart(6)}   ${String(r.min).padEnd(4)}   ` +
    `#${r.color.padEnd(7)} #${r.bg.padEnd(7)} ${r.pass ? '  ' : '✗ '}${r.where}`,
  )
}
console.log('')

if (bad.length) {
  console.log(`[check-contrast] 不达标 ${bad.length} 处：`)
  for (const r of bad) {
    console.log(`  ✗ ${r.where}  #${r.color} on #${r.bg} = ${r.ratio.toFixed(2)}:1（需 ≥ ${r.min}:1）`)
  }
  process.exit(1)
}
console.log('[check-contrast] 全部通过。')
