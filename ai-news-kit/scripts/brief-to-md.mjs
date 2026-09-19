#!/usr/bin/env node
/**
 * brief.json → Markdown 日报（降级产物 & 人类可读版）
 *
 * 定位：brief.json 是唯一真相源，本脚本只做「渲染」，不做任何判断。
 * 当 pptx 渲染不可用时，这份 Markdown 就是兜底交付物 —— 内容完整，可直接复制使用。
 *
 * 用法：
 *   node scripts/brief-to-md.mjs --date 2026-09-14 [--out path.md] [--brief file.json]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')
const args = process.argv.slice(2)
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const DATE = getArg('--date', null)
const BRIEF_PATH = getArg('--brief', null)
if (!DATE && !BRIEF_PATH) { console.error('usage: node scripts/brief-to-md.mjs --date YYYY-MM-DD [--out FILE]'); process.exit(2) }

const briefFile = BRIEF_PATH ? resolve(BRIEF_PATH) : join(KIT, 'data', DATE, 'brief.json')
if (!existsSync(briefFile)) { console.error(`[brief-to-md] 找不到 ${briefFile}`); process.exit(2) }
const b = JSON.parse(await readFile(briefFile, 'utf8'))
const date = b.date || DATE

const L = []
L.push(`# AI 新闻每日推送 · ${date}`)
L.push('')
L.push(`> **侧重方向**：${(b.focus || []).join(' × ')}`)
L.push(`> **新闻窗口**：${b.windowNote || ''}`)
L.push('')

const st = b.rawStats || {}
L.push(`**本批数据**：原始 ${st.rawItems ?? '—'} 条 · 信源 ${st.sourcesAlive ?? '—'}/${st.sourcesTotal ?? '—'} 个 · 多源共同报道 ${st.multiSourceItems ?? '—'} 条 · 精选 ${(b.picks || []).length} 条`)
L.push('')

L.push('## 〇、今日一句话')
L.push('')
L.push(b.headline || '')
L.push('')

L.push('## 一、置信度评级方法')
L.push('')
L.push('| 等级 | 判定标准 |')
L.push('|---|---|')
;(b.confidenceScale || []).forEach((c) => L.push(`| **${c.lv} ${c.name}** | ${c.rule} |`))
L.push('')
L.push('> ⚠️ **方法论提示**：刻意区分「**转载数量**」与「**独立信源数量**」。多家媒体转述同一家独家 ≠ 多方验证，这类一律降级（本期第 5 条即为例）。')
L.push('')

// 按主题分组
const groups = {}
;(b.picks || []).forEach((p) => { (groups[p.topic] ||= []).push(p) })
let gi = 0
for (const [topic, items] of Object.entries(groups)) {
  gi++
  const cn = ['一', '二', '三', '四', '五', '六'][gi] || String(gi)
  L.push(`## ${cn}、${topic}（${items.length} 条）`)
  L.push('')
  for (const p of items) {
    L.push(`### ${p.no}. [置信度 ${p.lv}] ${p.title}`)
    L.push('')
    if (p.publishedAt) L.push(`**发布时间**：${p.publishedAt}`)
    L.push('')
    L.push(`**事件内容**：${p.event}`)
    L.push('')
    if ((p.keyFacts || []).length) {
      L.push('**关键数字 / 事实**：')
      L.push('')
      p.keyFacts.forEach((f) => L.push(`- ${f}`))
      L.push('')
    }
    L.push(`**为何值得关注**：${p.why}`)
    L.push('')
    if (p.conflicts) { L.push(`**多方对比与差异**：${p.conflicts}`); L.push('') }
    L.push('**来源 / 原作者**：')
    L.push('')
    ;(p.sources || []).forEach((s) => L.push(`- ${s.name} → ${s.url}`))
    L.push('')
    L.push('---')
    L.push('')
  }
}

const scanIdx = ['一', '二', '三', '四', '五', '六'][gi + 1] || String(gi + 1)
L.push(`## ${scanIdx}、今日其他值得瞄一眼的动态`)
L.push('')
;(b.alsoWorthAScan || []).forEach((a, i) => {
  L.push(`${i + 1}. ${a.title}`)
  L.push(`   - 信源：${a.sources || '—'}`)
})
L.push('')
L.push('> 这些条目或信源不足、或与正条目主题重复、或已在上一轮推送过，因此只列不展开。')
L.push('')

L.push(`## ${['一', '二', '三', '四', '五', '六'][gi + 2] || String(gi + 2)}、数据与方法`)
L.push('')
L.push(`- 抓取源：${st.sourcesTotal ?? '—'} 个（本批存活 ${st.sourcesAlive ?? '—'} 个）`)
const cat = st.byCategory || {}
L.push(`- 分类分布：AI Coding ${cat['AI Coding'] ?? 0} / 具身智能 ${cat['具身智能'] ?? 0} / 其他 ${cat['其他'] ?? 0} / AI 政策 ${cat['AI 政策'] ?? 0}`)
L.push(`- ${st.note || ''}`)
L.push(`- 历史去重：${b.dedupeNote || ''}`)
L.push('')
L.push('> ⚠️ **免责**：本报告的每条结论都只反映「有多少个相互独立的信源在说同一件事」，不等同于这件事已被核实为真。引用前请回到一手来源确认。')
L.push('')

const outFile = getArg('--out', join(KIT, '..', `AI新闻推送_${date}.md`))
await mkdir(dirname(resolve(outFile)), { recursive: true })
await writeFile(resolve(outFile), L.join('\n'), 'utf8')
console.log(`[brief-to-md] 已输出：${resolve(outFile)}`)
