#!/usr/bin/env node
/**
 * 版式体检：复用 build-pptx.mjs 的度量公式，算出每个文本块的「填充率」。
 *
 * 目的：把"看起来有点空/有点挤"变成可比较的数字，回答两个问题：
 *   1) 哪些块内容长期装不满（浪费版面）
 *   2) 哪些块长期接近上限（内容是靠"恰好"过关，改天数据长一点就溢出）
 *
 * 用法：node scripts/audit-layout.mjs --brief data/2026-09-14/brief.json
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const getArg = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const briefPath = resolve(getArg('--brief', 'data/2026-09-14/brief.json'))
const brief = JSON.parse(await readFile(briefPath, 'utf8'))

function textWidthIn(str, pt) {
  let w = 0
  for (const ch of String(str)) {
    w += (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1.0 : 0.55) * pt / 72
  }
  return w * 1.05
}
function lineH(pt, mult) { return pt * (mult || 1.2) * 1.35 / 72 }
function needH(text, w, pt, mult) {
  const lines = Math.max(1, Math.ceil(textWidthIn(text, pt) / (w - 0.25)))
  return lines * lineH(pt, mult)
}
function fill(need, box) { return need / box }

const rows = []
const push = (page, name, text, w, h, pt, mult) => {
  const chars = [...String(text)].length
  const n = needH(text, w, pt, mult)
  rows.push({ page, name, pt, chars, need: +n.toFixed(2), box: h, pct: Math.round(fill(n, h) * 100) })
}

// ---- P4+ 要闻页（对所有 picks 各算一遍） ----
for (const p of brief.picks || []) {
  const tag = `P要闻#${p.no}`
  push(tag, '标题', p.title, 13.33 - 1.2, 0.9, 19, 1.2)
  push(tag, '事件', p.event || '', 6.9, 1.5, 11, 1.18)
  const factsLen = (p.keyFacts || []).reduce((s, f) => s + [...String(f)].length, 0)
  // keyFacts 是逐条 bullet，每条约占整行数
  const factNeed = (p.keyFacts || []).reduce((s, f) => s + needH(f, 6.4, 9.5, 1.2), 0)
  rows.push({ page: tag, name: '关键数字框', pt: 9.5, chars: factsLen, need: +factNeed.toFixed(2), box: 1.76, pct: Math.round(factNeed / 1.76 * 100) })
  push(tag, '为什么值得关注', p.why || '', 4.73, 3.65, 11, 1.22)
  push(tag, '来源行', `来源（${(p.sources || []).length}）：` + (p.sources || []).map((x) => x.name).join(' ｜ '), 12.13, 0.3, 9, 1.2)
}

// ---- 封面 ----
push('P1', '今日一句话', brief.headline || '', 10.7, 0.98, 12, 1.3)
// ---- P3 方法页 ----
;(brief.confidenceScale || []).forEach((c, i) => push('P3', `规则 ${c.lv}`, c.rule, 13.33 - 2.2, 0.32, 11, 1.2))
// ---- 扫读清单表 ----
;(brief.alsoWorthAScan || []).forEach((a, i) => {
  const need = needH(a.title, 8.6, 11, 1.2)
  rows.push({ page: 'P扫读', name: `行${i + 1}`, pt: 11, chars: [...a.title].length, need: +need.toFixed(2), box: 0.6, pct: Math.round(need / 0.6 * 100) })
})

rows.sort((a, b) => b.pct - a.pct)

// ---- 容量预算表模式：给定盒子尺寸，反推各字号能装多少字 ----
// 这是"把装得下从运气变成契约"的依据：确定字号 → 得到字数上限 → 写成 brief 的硬约束。
const CAPACITY = process.argv.includes('--capacity')
if (CAPACITY) {
  const boxes = [
    { name: '关键数字框 keyFacts', w: 6.4, h: 1.76 },
    { name: '事件 event', w: 6.9, h: 1.5 },
    { name: '为什么值得关注 why', w: 4.73, h: 3.65 },
    { name: '标题 title（单行上限）', w: 12.13, h: 0.9 },
    { name: '今日一句话 headline', w: 10.7, h: 0.98 },
    { name: '来源行 sources', w: 12.13, h: 0.3 },
    { name: '扫读清单单行', w: 8.6, h: 0.6 },
  ]
  const sizes = [9, 9.5, 10, 11, 12, 13, 14, 15, 16, 18, 20]
  console.log('[audit-layout] 容量预算表（CJK 按全宽 1.0 估算，含 5% 安全余量）')
  console.log('[audit-layout] 读法：某盒在某字号下最多能放多少汉字；超出即渲染失败（exit 1，不产出 PPT）')
  console.log('')
  console.log('  文本块                     ' + sizes.map((s) => (s + 'pt').padStart(7)).join(''))
  for (const b of boxes) {
    const cells = sizes.map((pt) => {
      const perLine = Math.max(1, Math.floor((b.w - 0.25) / (pt / 72 * 1.05)))
      const lines = Math.max(1, Math.floor(b.h / lineH(pt, 1.2)))
      const cap = perLine * lines
      return String(cap).padStart(7)
    })
    console.log('  ' + b.name.padEnd(24) + cells.join(''))
  }
  console.log('')
  console.log('  说明：标题/来源行按单行估算（实际换行会掉行）；keyFacts 多条时会因逐条取整而损失容量。')
  process.exit(0)
}

const total = rows.length
const stuck = rows.filter((r) => r.pct >= 85).length
const empty = rows.filter((r) => r.pct <= 40).length

console.log(`[audit-layout] brief: ${briefPath}`)
console.log(`[audit-layout] 共 ${total} 个文本块`)
console.log(`  逼近上限(≥85%，数据再长一点就溢出)：${stuck} 个`)
console.log(`  装不满(≤40%，版面浪费)：${empty} 个`)
console.log('')
console.log('  填充%   块                字号   字数   需要   容器')
console.log('  -----   ---------------   ----   ----   ----   ----')
for (const r of rows) {
  const flag = r.pct >= 85 ? '⚠满' : r.pct <= 40 ? '·空' : '  '
  console.log(
    `  ${String(r.pct).padStart(4)}%   ${r.name.padEnd(15)}   ${String(r.pt).padStart(4)}   ` +
    `${String(r.chars).padStart(4)}   ${String(r.need).padStart(4)}   ${String(r.box).padStart(4)} ${flag}  <${r.page}>`,
  )
}
