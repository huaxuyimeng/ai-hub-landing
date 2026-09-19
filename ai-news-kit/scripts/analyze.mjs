#!/usr/bin/env node
/**
 * news.json + brief.json → brief.json 里的 `charts` 块（纯统计）
 *
 * 为什么单独一条脚本、而不是让渲染器自己算：
 *   项目的架构铁律是「brief.json 是唯一真相源，渲染脚本只渲染、不做判断」。
 *   图表数据是**计算**（计数、聚合、排序），如果放进 build-pptx.mjs，
 *   渲染器就悄悄变成了第二个真相源 —— 同一份 brief 换个渲染器就会得到不同图表。
 *   所以这里把算好的结果**写回 brief.json**，渲染器依旧只读不算。
 *
 * 它是统计，不是判断：
 *   只做关键词子串计数与按日聚合，不判断哪条重要、不判定置信度、不改任何 picks。
 *   所以它可以在 Agent 选稿之后随时重跑，且是幂等的（只覆盖 brief.charts）。
 *
 * 用法：
 *   node scripts/analyze.mjs --date 2026-09-14
 *   node scripts/analyze.mjs --brief data/2026-09-14/brief.json
 *   node scripts/analyze.mjs --date 2026-09-14 --bg-dump ./bg      # 顺便导出背景图供预览
 *
 * 退出码：0 成功 / 1 数据不足（不写盘） / 2 用法或文件缺失
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBackgrounds, assertLightEnough } from './lib/png.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')

const args = process.argv.slice(2)
function getArg(key, def) {
  const eq = args.find((a) => a.startsWith(key + '='))
  if (eq) return eq.slice(key.length + 1)
  const i = args.indexOf(key)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return def
}

const DATE = getArg('--date', null)
const BRIEF_ARG = getArg('--brief', null)
if (!DATE && !BRIEF_ARG) {
  console.error('usage: node scripts/analyze.mjs --date YYYY-MM-DD [--brief FILE] [--bg-dump DIR]')
  process.exit(2)
}

const BRIEF = resolve(BRIEF_ARG || join(KIT, 'data', DATE, 'brief.json'))
if (!existsSync(BRIEF)) {
  console.error(`[analyze] 找不到选稿文件：${BRIEF}`)
  process.exit(2)
}
const brief = JSON.parse(await readFile(BRIEF, 'utf8'))
const date = brief.date || DATE

const NEWS = join(KIT, 'data', date, 'news.json')
if (!existsSync(NEWS)) {
  console.error(`[analyze] 找不到抓取结果：${NEWS}\n  先跑 node scripts/aggregate.mjs --date ${date}`)
  process.exit(2)
}
const news = JSON.parse(await readFile(NEWS, 'utf8'))
const items = Array.isArray(news.items) ? news.items : []
if (!items.length) {
  console.error('[analyze] news.json 里没有条目，无法出图。')
  process.exit(1)
}

const cfgModels = JSON.parse(await readFile(join(KIT, 'config', 'models.json'), 'utf8'))
const cfgSources = existsSync(join(KIT, 'config', 'sources.json'))
  ? JSON.parse(await readFile(join(KIT, 'config', 'sources.json'), 'utf8'))
  : { sources: [] }
const SRC_LABEL = Object.fromEntries((cfgSources.sources || []).map((s) => [s.id, s.label || s.id]))
const TREND_DAYS = cfgModels.trend?.days ?? 10
const TREND_SERIES = cfgModels.trend?.series ?? 5
const TOP_N = cfgModels.trend?.topN ?? 12

// ---------------- 工具 ----------------
const ENT = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&hellip;': '…', '&mdash;': '—', '&rsquo;': '’', '&ldquo;': '“', '&rdquo;': '”' }
function clean(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENT[m.toLowerCase()] ?? ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 本地时区（GMT+8）日期。绝不用 toISOString —— 凌晨会把日期算到前一天。 */
const DTF = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})
function localDate(ms) {
  if (!ms) return null
  const p = Object.fromEntries(DTF.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

// ---------------- ① 置信度分布（来自选稿，不是语料） ----------------
const confidence = { A: 0, B: 0, C: 0, D: 0 }
for (const p of brief.picks || []) if (confidence[p.lv] != null) confidence[p.lv]++

// ---------------- ② 语料分类分布 ----------------
const byCategory = {}
for (const it of items) byCategory[it.category || '其他'] = (byCategory[it.category || '其他'] || 0) + 1
const category = Object.entries(byCategory)
  .map(([name, count]) => ({ name, count }))
  .sort((a, b) => b.count - a.count)

// ---------------- ③ 信源贡献 ----------------
const bySource = {}
for (const it of items) {
  const s = it.source || 'unknown'
  bySource[s] = (bySource[s] || 0) + 1
}
const sources = Object.entries(bySource)
  .map(([id, count]) => ({ id, label: SRC_LABEL[id] || id, count }))
  .sort((a, b) => b.count - a.count)

// ---------------- ④ 主体提及（模型 / 编码助手 / 具身智能公司） ----------------
const GROUPS = (cfgModels.groups || []).map((g) => ({
  ...g,
  kw: (g.keywords || []).map((k) => k.toLowerCase()),
}))

const daily = {}          // date → { total, byGroup: {id: count} }
const mention = Object.fromEntries(GROUPS.map((g) => [g.id, 0]))
const days = new Set()

for (const it of items) {
  const d = localDate(it.publishedAt)
  if (!d) continue
  days.add(d)
  daily[d] = daily[d] || { total: 0, byGroup: {} }
  daily[d].total++

  const hay = (clean(it.title) + ' ' + clean(it.summary)).toLowerCase()
  for (const g of GROUPS) {
    if (g.kw.some((k) => hay.includes(k))) {
      mention[g.id]++
      daily[d].byGroup[g.id] = (daily[d].byGroup[g.id] || 0) + 1
    }
  }
}

const mentionTop = GROUPS
  .map((g) => ({ id: g.id, label: g.label, kind: g.kind, count: mention[g.id] || 0 }))
  .filter((m) => m.count > 0)
  .sort((a, b) => b.count - a.count)
  .slice(0, TOP_N)

// 按类别各出一份榜单。
// 为什么不能只留一个总榜：总榜按计数排序，大模型厂商（GPT 33、Claude 21…）
// 会把具身智能公司（多数只有 1–3 次）整片挤出去 —— 而本期恰恰是
// 「AI Coding × 具身智能」双方向，具身那半边会给挤成空白。
const topByKind = {}
for (const kind of ['model', 'agent', 'robot']) {
  topByKind[kind] = GROUPS
    .map((g) => ({ id: g.id, label: g.label, kind: g.kind, count: mention[g.id] || 0 }))
    .filter((m) => m.kind === kind && m.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
}

const byKind = { model: 0, agent: 0, robot: 0 }
for (const g of GROUPS) byKind[g.kind] = (byKind[g.kind] || 0) + (mention[g.id] || 0)

// ---------------- ⑤ 趋势（逐日计数） ----------------
// 只用语料里真实出现过的日期，窗口取「语料最后一天往前 N 天」。
// ⚠ 这是个**覆盖不完整**的口径：聚合源的 RSS 只回最近一批条目，
//   越早的日期语料越少。所以趋势图只用来比「同一窗口内的相对高低」，
//   不能当全网热度读 —— 页面上会明说。
const allDays = [...days].sort()
const lastDay = allDays[allDays.length - 1] || date
const startMs = new Date(lastDay + 'T00:00:00+08:00').getTime() - (TREND_DAYS - 1) * 86400000
const windowDays = allDays.filter((d) => new Date(d + 'T00:00:00+08:00').getTime() >= startMs)

const seriesIds = mentionTop.slice(0, TREND_SERIES).map((m) => m.id)
const trend = {
  days: windowDays.map((d) => d.slice(5)),      // 只留 MM-DD，图上不挤
  dates: windowDays,
  series: seriesIds.map((id) => {
    const g = GROUPS.find((x) => x.id === id)
    return {
      id,
      label: g ? g.label : id,
      values: windowDays.map((d) => (daily[d]?.byGroup?.[id] || 0)),
    }
  }),
  dailyTotals: windowDays.map((d) => daily[d]?.total || 0),
  windowDays: windowDays.length,
}

// ---------------- ⑥ 语料元信息 ----------------
const corpus = {
  items: items.length,
  from: allDays[0] || null,
  to: lastDay,
  spanDays: allDays.length,
  fetchedAt: news.fetchedAt || null,
  note: '趋势与热度统计的是**本期抓取语料**里的提及次数，不是全网声量。聚合源只回最近一批条目，越早的日期覆盖越不完整。',
}

// ---------------- 背景图（顺手自检 + 可导出预览） ----------------
const bgs = buildBackgrounds(640, 360, 2)
const bgIssues = assertLightEnough(bgs)
if (bgIssues.length) {
  console.error(`[analyze] 背景图明度不达标（会破坏「白底浅色」约定）：\n  ${bgIssues.join('\n  ')}`)
  process.exit(1)
}
const BG_DUMP = getArg('--bg-dump', null)
if (BG_DUMP) {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(resolve(BG_DUMP), { recursive: true })
  for (const [name, v] of Object.entries(bgs)) {
    await writeFile(join(resolve(BG_DUMP), `bg-${name}.png`), v.png)
  }
  console.log(`[analyze] 背景图已导出到 ${resolve(BG_DUMP)}（${Object.keys(bgs).length} 张）`)
}

// ---------------- 写回 brief.json ----------------
brief.charts = {
  generatedBy: 'analyze.mjs',
  generatedAt: new Date().toISOString(),
  corpus,
  confidence,
  category,
  sources,
  models: { top: mentionTop, topByKind, byKind, trend },
}
await writeFile(BRIEF, JSON.stringify(brief, null, 2) + '\n', 'utf8')

console.log(`[analyze] 已写入 charts：${BRIEF}`)
console.log(`  语料 ${corpus.items} 条 · ${corpus.from} → ${corpus.to}（${corpus.spanDays} 天）`)
console.log(`  置信度 ${Object.entries(confidence).map(([k, v]) => k + '×' + v).join(' ')}`)
console.log(`  分类 ${category.map((c) => c.name + ' ' + c.count).join(' · ')}`)
console.log(`  信源 Top3 ${sources.slice(0, 3).map((s) => s.label + ' ' + s.count).join(' · ')}`)
console.log(`  提及 Top${mentionTop.length} ${mentionTop.slice(0, 5).map((m) => m.label + ' ' + m.count).join(' · ')}`)
console.log(`  趋势窗口 ${trend.windowDays} 天（${trend.days.join('/')}），系列 ${seriesIds.length} 条`)
console.log('  提醒：图表口径是「抓取语料内的提及次数」，不是全网声量。')
