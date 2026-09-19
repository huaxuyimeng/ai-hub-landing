#!/usr/bin/env node
/**
 * agent-pick.mjs — 用 DeepSeek 做 Agent 选稿
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-... node scripts/agent-pick.mjs --date 2026-09-19 [--model deepseek-chat] [--news FILE] [--out FILE]
 *
 * 退出码：0 成功 / 1 失败（调用方应降级到机器草稿） / 2 用法错误
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')
const DATA_DIR = process.env.AIHUB_DATA_DIR || join(KIT, 'data')

const args = process.argv.slice(2)
function getArg(key, def) {
  const eq = args.find((a) => a.startsWith(key + '='))
  if (eq) return eq.slice(key.length + 1)
  const i = args.indexOf(key)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def
}
const DATE = getArg('--date', null)
const NEWS_ARG = getArg('--news', null)
const OUT_ARG = getArg('--out', null)
const MODEL_ARG = getArg('--model', null)

if (!DATE && !NEWS_ARG) {
  console.error('usage: DEEPSEEK_API_KEY=sk-... node scripts/agent-pick.mjs --date YYYY-MM-DD [--news FILE] [--out FILE] [--model ID]')
  process.exit(2)
}
if (DATE && !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`[agent-pick] 日期格式不对：${DATE}`); process.exit(2)
}
const NEWS = resolve(NEWS_ARG || join(DATA_DIR, DATE, 'news.json'))
const OUT = resolve(OUT_ARG || join(DATA_DIR, DATE, 'brief.json'))
if (!existsSync(NEWS)) {
  console.error(`[agent-pick] 找不到 news.json：${NEWS}`); process.exit(2)
}

const MODEL_MAP = {
  'deepseek-chat':     { model: 'deepseek-chat',     baseUrl: 'https://api.deepseek.com/v1' },
  'deepseek-reasoner': { model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' },
}
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'deepseek-chat'
const MODEL_ID = MODEL_ARG || DEFAULT_MODEL
const MODEL = MODEL_MAP[MODEL_ID]
if (!MODEL) {
  console.error(`[agent-pick] 未知模型：${MODEL_ID}，可用：${Object.keys(MODEL_MAP).join(', ')}`)
  process.exit(2)
}

const API_KEY = process.env.DEEPSEEK_API_KEY
if (!API_KEY) {
  console.error('[agent-pick] 缺少 DEEPSEEK_API_KEY 环境变量')
  process.exit(2)
}

const BUDGET = { title: 84, event: 230, factEach: 68, factTotal: 300, why: 300, headline: 150, srcName: 14, conflicts: 88, scan: 100 }
const CONFIDENCE_SCALE = [
  { lv: 'A', name: '极高', rule: '≥3 个独立信源，且可追溯到一手官方材料' },
  { lv: 'B', name: '高', rule: '2 个独立信源，或 1 个信源 + 一手官方材料' },
  { lv: 'C', name: '中', rule: '单一信源报道，无第二方印证' },
  { lv: 'D', name: '存疑', rule: '关键数字矛盾，或全部报道可溯源到同一原始信源' },
]

function clean(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s+/g, ' ').trim()
}
function fit(s, max) {
  const t = clean(s)
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'))
  if (cut > max * 0.5) return head.slice(0, cut + 1)
  const soft = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','))
  if (soft > max * 0.6) return head.slice(0, soft + 1) + '…'
  return head.replace(/[\s,，、;；:：]$/, '') + '…'
}

const news = JSON.parse(readFileSync(NEWS, 'utf8'))
const items = Array.isArray(news.items) ? news.items : []
if (!items.length) { console.error('[agent-pick] news.json 里没有条目'); process.exit(1) }

const candidates = items
  .filter((it) => clean(it.title).length >= 10)
  .map((it) => ({
    id: it.id,
    title: clean(it.title),
    summary: clean(it.summary || '').slice(0, 240),
    source: it.source,
    sourceLabel: it.sourceLabel || it.source || '',
    category: it.category || '未分类',
    publishedAt: it.publishedAt,
    srcCount: Array.isArray(it.sources) ? it.sources.length : 1,
  }))

const SYSTEM_PROMPT = `你是「AI 日报 Agent 选稿员」。从候选新闻里挑 5 条最值得放进今日日报的，按 JSON Schema 输出，不要任何解释、不要 markdown 代码块。字段长度严格遵守 budget 限制。`

const USER_PROMPT = JSON.stringify({
  task: '从 candidates 选 5 条（不足 5 也允许，但 ≥3 才有效），按「时效 + 重要性」排序；为每条写 why（30 字内判断）；按 confidenceScale 给 lv；为整批写 headline（≤150 字）。',
  budget: BUDGET,
  confidenceScale: CONFIDENCE_SCALE,
  rules: [
    'picks 长度 = 5（不足 5 也允许，但 ≥3 才有意义）',
    '每条 sources = [{ name, url }]，name ≤40 字，url 必须是真实可点的',
    'keyFacts 每条 ≤68 字，总和 ≤300 字，至少 3 条',
    'why ≤300 字，必须是判断，不是事实复述',
    'event ≤230 字',
    'headline ≤150 字',
    'lv 必须是 A/B/C/D 之一',
    '只输出 JSON，无任何其他文本',
  ],
  candidates: candidates.slice(0, 120),
}, null, 0)

async function callDeepSeek() {
  const url = `${MODEL.baseUrl}/chat/completions`
  const body = {
    model: MODEL.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 45000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) throw new Error('返回内容为空')
    return content
  } finally {
    clearTimeout(t)
  }
}

function validateAndShape(raw, items, date) {
  let parsed
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw } catch (e) {
    throw new Error(`LLM 返回的不是合法 JSON：${e.message}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('LLM 返回的不是对象')
  if (!Array.isArray(parsed.picks)) throw new Error('缺少 picks 数组')
  if (parsed.picks.length < 3) throw new Error(`picks 只有 ${parsed.picks.length} 条，少于 3`)

  const out = {
    date, draft: false, generatedBy: `agent:${MODEL_ID}`,
    generatedAt: new Date().toISOString(),
    windowNote: `Agent 选稿 · 模型 ${MODEL_ID} · 数据窗口 ${news.fetchedAt || '未知'}`,
    focus: parsed.focus || ['AI Coding', '具身智能'],
    headline: fit(parsed.headline || '今日 AI 圈要点', BUDGET.headline),
    rawStats: parsed.rawStats || { sourcesAlive: 0, sourcesTotal: 0, rawItems: items.length, dedupedItems: items.length, multiSourceItems: 0, byCategory: {} },
    confidenceScale: CONFIDENCE_SCALE,
    picks: parsed.picks.map((p, i) => {
      const orig = items.find((it) => it.id === p.id || clean(it.title) === clean(p.title)) || {}
      const sources = Array.isArray(p.sources) && p.sources.length
        ? p.sources.slice(0, 3).map((s) => ({ name: fit(s.name || '', 40), url: String(s.url || orig.url || '').replace(/&amp;/g, '&') }))
        : [{ name: fit(orig.sourceLabel || orig.source || '', 40), url: String(orig.url || '').replace(/&amp;/g, '&') }]
      const keyFacts = Array.isArray(p.keyFacts) ? p.keyFacts.slice(0, 4).map((f) => fit(f, BUDGET.factEach)) : []
      while (keyFacts.length < 3) {
        if (keyFacts.length === 0) keyFacts.push(fit(`来源：${orig.sourceLabel || orig.source || '—'}`, BUDGET.factEach))
        else if (keyFacts.length === 1 && orig.publishedAt) keyFacts.push(fit(`发布时间：${new Date(orig.publishedAt).toISOString().slice(0, 10)}`, BUDGET.factEach))
        else keyFacts.push(fit(`分类：${orig.category || '未分类'}`, BUDGET.factEach))
      }
      return {
        no: i + 1,
        topic: p.topic || orig.category || 'AI Coding',
        title: fit(p.title || orig.title || '', BUDGET.title),
        lv: ['A', 'B', 'C', 'D'].includes(p.lv) ? p.lv : 'C',
        publishedAt: p.publishedAt || new Date(orig.publishedAt || Date.now()).toISOString().slice(0, 10),
        event: fit(p.event || '', BUDGET.event),
        keyFacts,
        why: fit(p.why || '（Agent 未提供点评）', BUDGET.why),
        sources,
        conflicts: fit(p.conflicts || '', BUDGET.conflicts),
      }
    }),
    alsoWorthAScan: Array.isArray(parsed.alsoWorthAScan) ? parsed.alsoWorthAScan.slice(0, 6).map((x) => ({ title: fit(x.title || '', BUDGET.scan), sources: fit(x.sources || '', 40) })) : [],
    dedupeNote: parsed.dedupeNote || `Agent 选稿 · 模型 ${MODEL_ID} · Vercel /tmp 无持久化历史`,
  }
  for (const p of out.picks) {
    if (p.title.length > BUDGET.title) throw new Error(`pick[${p.no}].title 超长：${p.title.length}`)
    if (p.event.length > BUDGET.event) throw new Error(`pick[${p.no}].event 超长`)
    if (p.why.length > BUDGET.why) throw new Error(`pick[${p.no}].why 超长`)
  }
  return out
}

const date = DATE || String(news.fetchedAt || '').slice(0, 10)
let lastErr = null
for (let attempt = 1; attempt <= 2; attempt++) {
  console.error(`[agent-pick] 第 ${attempt} 次调用 ${MODEL_ID}…`)
  try {
    const raw = await callDeepSeek()
    const brief = validateAndShape(raw, items, date)
    await mkdir(dirname(OUT), { recursive: true })
    await writeFile(OUT, JSON.stringify(brief, null, 2) + '\n', 'utf8')
    const dist = brief.picks.reduce((a, p) => ((a[p.lv] = (a[p.lv] || 0) + 1), a), {})
    console.log(`[agent-pick] ✅ 已生成：${OUT}`)
    console.log(`[agent-pick] picks ${brief.picks.length} 条（${Object.entries(dist).map(([k, v]) => k + '×' + v).join(' · ') || '—'}）`)
    process.exit(0)
  } catch (e) {
    lastErr = e
    console.error(`[agent-pick] 第 ${attempt} 次失败：${e.message}`)
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1000))
  }
}
console.error(`[agent-pick] 两次都失败。调用方应降级到机器草稿。最后错误：${lastErr?.message}`)
process.exit(1)
