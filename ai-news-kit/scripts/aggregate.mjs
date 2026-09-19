#!/usr/bin/env node
/**
 * AI 新闻聚合器 —— 多源抓取 → 归一化 → 去重 → 分类 → 按日期归档
 *
 * 数据源（10 个标准源，详见下方 SOURCES 注释）：
 *   AI 垂媒：aitntnews(RSS) / ai-bot(正则) / 量子位(RSS)
 *   技术补量：InfoQ 中文 / 极客公园 / 雷峰网
 *   英文一手：TechCrunch AI / MIT TR AI / The Verge AI(Atom) / Hacker News(Algolia)
 *   可选增强：B 站两位 UP 主（默认只读缓存，--fetch-bilibili 才重抓）
 * 源可达性实测记录见 docs/source-probe.md。
 *
 * 产出：
 *   data/YYYY-MM-DD/news.json  当日归档（日期文件夹，2026-08-28 起；旧平铺文件只读兼容）
 *   data/index.json        日期索引（供日历高亮）
 *   data/health.json       源健康度（连续失败计数，供告警）
 *
 * 用法：
 *   node scripts/aggregate.mjs                 # 抓今天
 *   node scripts/aggregate.mjs --date 2026-08-28
 *   node scripts/aggregate.mjs --no-bilibili   # 跳过 B 站（省时间）
 *   node scripts/aggregate.mjs --fetch-bilibili
 */
import { writeFile, readFile, mkdir, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localDate, localDateTime } from './date-util.mjs'
import { writeDay, readDay, listDates, writeJsonAtomic } from './storage.mjs'
import {
  timeUnknown, fixRssYear, parseCnDateTime, parseUploadDate, parseTodayHM, parseMonthDay,
} from './time-utils.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const DATA_DIR = process.env.AIHUB_DATA_DIR || join(ROOT, 'data')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'

// ---------------- 配置 ----------------
/**
 * 数据源清单（2026-08-29 实测重排，见 docs/source-probe.md）
 *
 * 重排原因：原 ai-bot(正则 HTML 爬虫) + maomu(正则爬虫) 合计占当日 49/101 条，
 * 站点改版即整体塌陷。本次引入 7 个标准 feed 源稀释风险，把正则爬虫占比压到 ~20%。
 *
 * ai-bot 为何保留而非替换：它是唯一 AI 垂直浓度高的源（40 条/日），
 * 实测可达的标准 feed 中纯 AI 垂媒只有量子位（10 条）。直接换掉会显著稀释日报质量。
 * 折中方案：保留 + 健康度监控 + 解析数为 0 时告警（见 sourceHealth）。
 *
 * 已实测失效并移除的源（勿再启用，除非重新探测）：
 *   机器之心 /rss、/rss/all  → 返回 text/html SPA 页
 *   36氪 /feed、/motif/feed  → 返回 WAF 挑战页
 *   HuggingFace blog feed    → fetch failed
 *   arXiv API                → fetch failed
 *   Bing / Google News RSS   → 重定向 HTML / HTTP 000
 *   maomu.com                → 正则爬虫，仅 9 条且 AI 浓度低，性价比最低
 *
 * kind: rss(aitnt 专用,修年份) | generic(标准 RSS) | atom | hn(Algolia JSON) | aibot(正则 HTML)
 * fragile: 标记为正则爬虫，失败时降级为警告而非错误
 */
const SOURCES = [
  // —— 第一梯队：AI 垂直媒体 ——
  { id: 'aitntnews', label: 'AI TNT News', url: 'https://www.aitntnews.com/ainews/rss.xml', kind: 'rss', enabled: true },
  { id: 'ai-bot', label: 'AI Bot 每日资讯', url: 'https://ai-bot.cn/daily-ai-news/', kind: 'aibot', enabled: true, fragile: true },
  { id: 'qbitai', label: '量子位', url: 'https://www.qbitai.com/feed', kind: 'generic', enabled: true },
  // —— 第二梯队：技术 / 科技补量 ——
  { id: 'infoq', label: 'InfoQ 中文', url: 'https://www.infoq.cn/feed', kind: 'generic', enabled: true },
  { id: 'geekpark', label: '极客公园', url: 'https://www.geekpark.net/rss', kind: 'generic', enabled: true },
  { id: 'leiphone', label: '雷峰网', url: 'https://www.leiphone.com/feed', kind: 'generic', enabled: true },
  // —— 第三梯队：英文一手 ——
  { id: 'tc-ai', label: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', kind: 'generic', enabled: true },
  { id: 'mit-ai', label: 'MIT TR AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', kind: 'generic', enabled: true },
  { id: 'verge-ai', label: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', kind: 'atom', enabled: true },
  { id: 'hn', label: 'Hacker News', url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E50&hitsPerPage=30', kind: 'hn', enabled: true },
]

const CATEGORY_KEYWORDS = {
  'AI Coding': ['coding', 'copilot', 'codex', 'claude code', 'cursor', 'qoder', 'zcode', 'harness',
    '编程', '智能体', '开发', 'agent', 'token', '代码', 'ide', '插件'],
  '具身智能': ['具身', '机器人', '人形', 'embodied', 'robot', 'humanoid', '机械臂', 'vla', '遥操'],
  'AI 政策': ['policy', 'regulation', '监管', '政策', '法案', '合规', '反垄断', '安全标准', '治理'],
}

// ---------------- 工具 ----------------
async function fetchText(url, { timeoutMs = 15000 } = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }, signal: ctl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally { clearTimeout(t) }
}

function stripHtml(s) {
  return (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function hashId(s) {
  // H-10：32 位字符串哈希在数据量扩大后有碰撞风险（id 冲突 → React key 复用错乱、去重误合），
  // 换成 sha1 前 12 位十六进制（48 bit），当前量级碰撞概率可忽略
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

/* ---------------- 发布时间解析 ----------------
 * 已拆到 scripts/time-utils.mjs（便于补回归测试）。
 * 原则不变：publishedAt 必须是真实发布时间，绝不用抓取时间冒充。
 * -------------------------------------------- */

function classify(title, summary = '') {
  const text = `${title} ${summary}`.toLowerCase()
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some((k) => text.includes(k.toLowerCase()))) return cat
  }
  return '其他'
}

// ---------------- 解析器 ----------------
function parseAitntRss(xml) {
  const items = []
  const re = /<item>([\s\S]*?)<\/item>/g
  let m, n = 0
  while ((m = re.exec(xml)) !== null && n < 40) {
    const b = m[1]
    const title = stripHtml((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '')
    const link = ((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '').trim()
    const desc = stripHtml((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '')
    if (!title || !link) continue
    // 真实发布时间：RSS pubDate（年份被源站写成 2001，需修正）
    const t = fixRssYear(((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim())
    items.push({
      title, summary: desc.slice(0, 300), url: link,
      source: 'aitntnews', sourceLabel: 'AI TNT News',
      publishedAt: t.ts, publishPrecision: t.precision,
    })
    n++
  }
  return items
}

function parseAiBot(html) {
  const items = []
  // 先扫描日期分组标记（"8月28·周五"），每条新闻用它之前最近的标记作为日期
  const marks = []
  const dmRe = /(\d{1,2}\s*月\s*\d{1,2})\s*[·•]\s*周[一二三四五六日]/g
  let dm
  while ((dm = dmRe.exec(html)) !== null) {
    marks.push({ idx: dm.index, t: parseMonthDay(dm[1]) })
  }
  const re = /<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/g
  let m, n = 0
  while ((m = re.exec(html)) !== null && n < 40) {
    const url = m[1]
    const title = stripHtml(m[2])
    if (!title || title.length < 4) continue
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 2500)
    const pM = after.match(/<p[^>]*class="text-muted text-sm"[^>]*>([\s\S]*?)<\/p>/)
    let summary = ''
    if (pM) {
      summary = stripHtml(pM[1].replace(/<span class="news-time[\s\S]*?<\/span>/g, '').replace(/<a[^>]*>([\s\S]*?)<\/a>/g, '$1')).slice(0, 300)
    }
    // 真实发布日期（该源无具体时刻）
    let t = timeUnknown()
    for (const mk of marks) if (mk.idx <= m.index) t = mk.t
    items.push({
      title, summary, url, source: 'ai-bot', sourceLabel: 'AI Bot 每日资讯',
      publishedAt: t.ts, publishPrecision: t.precision,
    })
    n++
  }
  return items
}

function parseMaomu(html) {
  const items = []
  const re = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>\s*<h3[^>]*class="title[^"]*"[^>]*>([\s\S]*?)<\/h3>\s*<div[^>]*class="desc[^"]*"[^>]*>([\s\S]*?)<\/div>/g
  let m, n = 0
  while ((m = re.exec(html)) !== null && n < 40) {
    const url = m[1]
    const title = stripHtml(m[2])
    const summary = stripHtml(m[3])
    if (!title || title.length < 4) continue
    // 真实发布时间：该条自带的 HH:MM（在 <a> 之前的 news-time 里，如 <span>16:07</span>）
    const before = html.slice(Math.max(0, m.index - 500), m.index)
    const timeHits = [...before.matchAll(
      /<div[^>]*class="news-time[^"]*"[^>]*>\s*<span[^>]*>\s*(\d{1,2}\s*:\s*\d{2})\s*<\/span>/g)]
    const t = timeHits.length ? parseTodayHM(timeHits[timeHits.length - 1][1]) : timeUnknown()
    // 来源名（同一 <a> 内的 source-name div）
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 600)
    const srcM = after.match(/<div[^>]*class="source-name[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    let sourceTag = ''
    if (srcM) sourceTag = stripHtml(srcM[1]).replace(/^来源：\s*/, '').trim()
    items.push({
      title, summary, url, source: 'maomu', sourceLabel: '猫目每日AI资讯',
      publishedAt: t.ts, publishPrecision: t.precision,
      tags: sourceTag ? [sourceTag] : [],
    })
    n++
  }
  return items
}

/** 通用 RSS 解析（标准 RSS 2.0，供大多数源复用） */
function parseGenericRss(xml, sourceId, sourceLabel, limit = 40) {
  const items = []
  // 兼容 <item> 与 <item attr="..."> 两种写法
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g
  let m, n = 0
  while ((m = re.exec(xml)) !== null && n < limit) {
    const b = m[1]
    const title = stripHtml((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '')
    const link = ((b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '').trim()
    const desc = stripHtml((b.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || '')
    if (!title || !link) continue
    // P0-1 口径统一：拿不到 pubDate 时保持 null（绝不回退成抓取时间 Date.now()）
    const pd = new Date(((b.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '').trim())
    const hasTs = !isNaN(pd.getTime())
    items.push({
      title, summary: desc.slice(0, 300), url: link,
      source: sourceId, sourceLabel,
      publishedAt: hasTs ? pd.getTime() : null,
      publishPrecision: hasTs ? 'exact' : null,
    })
    n++
  }
  return items
}

/** Atom 解析（The Verge 等使用 Atom 1.0，条目标签为 <entry>，链接在 href 属性里） */
function parseAtom(xml, sourceId, sourceLabel, limit = 40) {
  const items = []
  const re = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g
  let m, n = 0
  while ((m = re.exec(xml)) !== null && n < limit) {
    const b = m[1]
    const title = stripHtml((b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '')
    // Atom 的链接形如 <link rel="alternate" href="..."/>，取第一个带 href 的
    const linkTags = [...b.matchAll(/<link[^>]*href="([^"]+)"[^>]*\/?>/g)]
    const alt = linkTags.find((x) => /rel="[^"]*alternate/.test(x[0])) || linkTags[0]
    const link = (alt?.[1] || '').trim()
    const desc = stripHtml(
      (b.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || b.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '')
    if (!title || !link) continue
    // Atom 时间字段可能是 <published> 或 <updated>
    const raw = ((b.match(/<published[^>]*>([\s\S]*?)<\/published>/) || b.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1] || '').trim()
    const pd = new Date(raw)
    const hasTs = !isNaN(pd.getTime())
    items.push({
      title, summary: desc.slice(0, 300), url: link,
      source: sourceId, sourceLabel,
      publishedAt: hasTs ? pd.getTime() : null,
      publishPrecision: hasTs ? 'exact' : null,
    })
    n++
  }
  return items
}

/**
 * Hacker News Algolia API 解析（JSON）
 * 用 search_by_date（按时间倒排）而非 search（按相关度），天然适合「每日抓取」。
 * numericFilters=points>N 服务端过滤热度，避免拉一堆无人问津的帖子。
 */
function parseHnAlgolia(json, sourceId, sourceLabel, limit = 40) {
  let hits = []
  try { hits = JSON.parse(json).hits || [] } catch { return [] }
  const items = []
  for (const h of hits.slice(0, limit)) {
    if (!h.title) continue
    // Ask HN / Show HN 这类无外链的，回退到 HN 站内讨论页
    const url = h.url || `https://news.ycombinator.com/item?id=${h.objectID}`
    const ts = h.created_at_i ? h.created_at_i * 1000 : null
    items.push({
      title: h.title,
      summary: (h.story_text ? stripHtml(h.story_text) : '').slice(0, 300),
      url,
      source: sourceId, sourceLabel,
      publishedAt: ts, publishPrecision: ts ? 'exact' : null,
      // HN 独有信号，前端可用来排序/筛选
      points: h.points ?? null,
      comments: h.num_comments ?? null,
    })
  }
  return items
}

// ---------------- 源健康度 ----------------
/**
 * 记录每个源的抓取结果，跨次累积连续失败/空结果计数。
 * 存在 data/health.json，供告警与「源是否已改版」排查。
 * 价值：正则爬虫（ai-bot）站点改版时条数会突降为 0，靠人工看日报才发现已太晚。
 */
const HEALTH_FILE = () => join(DATA_DIR, 'health.json')
const HEALTH_FAIL_THRESHOLD = 2   // 连续 N 次异常即标记 unhealthy

async function loadHealth() {
  try { return JSON.parse(await readFile(HEALTH_FILE(), 'utf8')) } catch { return { sources: {} } }
}

async function saveHealth(health) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeJsonAtomic(HEALTH_FILE(), { ...health, updatedAt: Date.now() })
}

/**
 * @param {object} health
 * @param {string} id
 * @param {{ok: boolean, count: number, ms: number, error?: string|null}} r
 */
function applyHealth(health, id, r) {
  const prev = health.sources[id] || { okStreak: 0, emptyStreak: 0, failStreak: 0, total: 0, lastOkAt: null }
  const next = {
    ...prev,
    total: (prev.total || 0) + 1,
    lastCount: r.count,
    lastMs: r.ms,
    lastError: r.error || null,
    lastAt: Date.now(),
  }
  if (r.ok && r.count > 0) {
    next.okStreak = (prev.okStreak || 0) + 1
    next.emptyStreak = 0
    next.failStreak = 0
    next.lastOkAt = Date.now()
  } else if (r.ok && r.count === 0) {
    // 抓到了但解析出 0 条 —— 正则爬虫改版的典型症状
    next.okStreak = 0
    next.emptyStreak = (prev.emptyStreak || 0) + 1
    next.failStreak = (prev.failStreak || 0) + 1
  } else {
    next.okStreak = 0
    next.emptyStreak = 0
    next.failStreak = (prev.failStreak || 0) + 1
  }
  next.unhealthy = next.failStreak >= HEALTH_FAIL_THRESHOLD
  health.sources[id] = next
  return next
}

// ---------------- B 站 ----------------
function runBilibili() {
  return new Promise((resolve) => {
    const py = process.platform === 'win32' ? 'python' : 'python3'
    const p = spawn(py, [join(ROOT, 'scripts', 'fetch_bilibili.py'), '--limit', '1'], { cwd: ROOT })
    let err = ''
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('close', (code) => resolve({ ok: code === 0, err }))
    p.on('error', () => resolve({ ok: false, err: 'python 不可用' }))
    // 最长 5 分钟
    setTimeout(() => { try { p.kill() } catch {} resolve({ ok: false, err: 'timeout' }) }, 300000)
  })
}

/**
 * 读取 B 站数据。带新鲜度判断：
 *   - 默认：缓存未超过 maxAgeMs 则直接用，避免频繁请求触发 B 站 412/352 风控
 *   - --force-bilibili：无条件重抓
 */
async function loadBilibili(maxAgeMs = 6 * 3600 * 1000, force = false) {
  const f = join(DATA_DIR, 'bilibili-news.json')
  if (!existsSync(f)) return { ups: [], stale: true }
  try {
    const d = JSON.parse(await readFile(f, 'utf8'))
    if (force) return { ...d, stale: true }
    const age = Date.now() - (d.fetchedAt || 0) * 1000
    return { ...d, stale: age > maxAgeMs }
  } catch { return { ups: [], stale: true } }
}

// ---------------- 主流程 ----------------
async function main() {
  const args = process.argv.slice(2)
  const getArg = (k, d) => {
    const i = args.indexOf(k)
    return i >= 0 && args[i + 1] ? args[i + 1] : d
  }
  const dateArg = getArg('--date', null)
  const noBili = args.includes('--no-bilibili')

  const now = new Date()
  // 用本地日期（非 UTC）：GMT+8 的 00:00–08:00 用 UTC 会归档到前一天
  const dateStr = dateArg || localDate(now)
  const errors = []
  const warnings = []

  console.log(`[aggregate] 目标日期 ${dateStr}`)

  /** 按 kind 分派解析器。新增数据源只需在这里加一行 + SOURCES 加一项。 */
  const parseByKind = (src, raw) => {
    switch (src.kind) {
      case 'rss': return parseAitntRss(raw)
      case 'generic': return parseGenericRss(raw, src.id, src.label)
      case 'atom': return parseAtom(raw, src.id, src.label)
      case 'hn': return parseHnAlgolia(raw, src.id, src.label)
      case 'aibot': return parseAiBot(raw)
      default: return []
    }
  }

  // 1) 多源抓取（并行 + 1 次重试：单源超时不再阻塞其余源，瞬时抖动也不丢整天数据）
  const all = []
  const health = await loadHealth()
  const fetchOne = async (src) => {
    const t0 = Date.now()
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await fetchText(src.url)
        const items = parseByKind(src, raw)
        return { src, items, error: null, ms: Date.now() - t0 }
      } catch (e) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500))   // 退避后重试一次
          continue
        }
        return { src, items: [], error: `${src.id}: ${e?.message || e}`, ms: Date.now() - t0 }
      }
    }
    return { src, items: [], error: `${src.id}: 未知（重试耗尽）`, ms: Date.now() - t0 }
  }
  const results = await Promise.all(SOURCES.filter((s) => s.enabled).map(fetchOne))
  for (const r of results) {
    const h = applyHealth(health, r.src.id, {
      ok: !r.error, count: r.items.length, ms: r.ms, error: r.error || null,
    })
    // fragile 源（正则爬虫）失败只降级为警告：它本来就是增强项，不该让整批失败
    const sink = r.src.fragile ? warnings : errors
    const pad = (r.src.id + '            ').slice(0, 12)
    if (r.error) {
      sink.push(r.error)
      console.log(`  ✗ ${pad} ${r.error}`)
    } else if (r.items.length === 0) {
      const msg = `${r.src.id}: 抓取成功但解析出 0 条（疑似改版或反爬）`
      sink.push(msg)
      console.log(`  ⚠ ${pad} 0 条 —— 疑似改版/反爬${r.src.fragile ? '（已降级为警告）' : ''}`)
    } else {
      all.push(...r.items)
      const flag = h.unhealthy ? '' : ''
      console.log(`  ✓ ${pad} ${String(r.items.length).padStart(3)} 条  ${String(r.ms).padStart(5)}ms${flag}`)
    }
    if (h.emptyStreak >= HEALTH_FAIL_THRESHOLD) {
      console.log(`     └ 连续 ${h.emptyStreak} 次空结果，请检查该源是否已改版`)
    }
  }
  await saveHealth(health)

  // 2) B 站
  //     B 站风控严（412/352）且抓取耗时数分钟，默认只读缓存；
  //     需要更新时显式加 --fetch-bilibili。这样每小时自动刷新才能保持秒级。
  const fetchBili = args.includes('--fetch-bilibili')
  let bilibili = { ups: [] }
  if (!noBili) {
    bilibili = await loadBilibili(Infinity, false)
    const cached = (bilibili.ups || []).reduce(
      (a, u) => a + (u.videos || []).reduce((b, v) => b + (v.news || []).length, 0), 0)
    if (fetchBili) {
      const r = await runBilibili()
      if (r.ok) console.log('  ✓ B 站抓取完成')
      else {
        // B 站 412 风控是常态。已移出关键路径：失败只记警告，绝不影响其余源产出。
        warnings.push(`bilibili: ${r.err.slice(0, 120)}`)
        console.log(`  ⚠ B 站未取到（412 风控，已降级，不影响其余源）`)
      }
      bilibili = await loadBilibili(Infinity, false)
    } else if (cached) {
      const ageH = ((Date.now() - (bilibili.fetchedAt || 0) * 1000) / 3600000).toFixed(1)
      console.log(`  ✓ B 站沿用缓存 ${cached} 条（${ageH} 小时前抓取，加 --fetch-bilibili 可重抓）`)
    } else {
      console.log('  · B 站无缓存（加 --fetch-bilibili 抓取）')
    }
  }

  // B 站条目并入主列表
  let biliCount = 0
  for (const up of bilibili.ups || []) {
    for (const v of up.videos || []) {
      // 真实发布时间：优先文字版发布时刻（精确），否则视频上传日期（仅日期）
      let vt = v.publishTime ? parseCnDateTime(v.publishTime) : timeUnknown()
      if (!vt.ts) vt = parseUploadDate(v.uploadDate)
      for (const n of v.news || []) {
        all.push({
          title: n.title, summary: n.summary || '', url: v.url,
          source: 'bilibili', sourceLabel: `${up.name}（B站）`,
          publishedAt: vt.ts, publishPrecision: vt.precision,
        })
        biliCount++
      }
    }
  }
  if (biliCount) console.log(`  ✓ B 站条目并入: ${biliCount} 条`)

  // 4) 归一化 + 分类 + 去重
  const fetchedAt = Date.now()
  const seen = new Map()
  for (const it of all) {
    const key = it.title.toLowerCase().replace(/[^\w\u4e00-\u9fa5]/g, '').slice(0, 40)
    if (!key) continue
    const exist = seen.get(key)
    if (exist) {
      if (!exist.sources.includes(it.source)) exist.sources.push(it.source)
      continue
    }
    seen.set(key, {
      id: hashId(it.url + it.title),
      title: it.title,
      summary: it.summary || '',
      url: it.url,
      source: it.source,
      sourceLabel: it.sourceLabel,
      sources: [it.source],
      category: classify(it.title, it.summary),
      // 真实发布时间；未知时保持 null（绝不回退成 fetchedAt，那是抓取时间）
      publishedAt: it.publishedAt ?? null,
      publishPrecision: it.publishPrecision ?? null,
      fetchedAt,
    })
  }

  // 按真实发布时间倒序；时间未知的（null）排最后
  const items = Array.from(seen.values())
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))

  // 4.5) 实体级多源关联
  //   跨源标题措辞往往不同（"腾讯混元推出 Hy4 preview" vs "实测混元 Hy4 Preview：能杀入第一梯队吗？"），
  //   精确去重匹配不上。这里提取产品名/型号等实体做指纹，共享 >=2 个实体即视为同一事件的多源报道。
  // 停用词：英文新闻高频通用词是跨源误判的主要来源，必须剔除。
  // 2026-08-29 实测：仅用原 17 词 + 阈值 2 时，47.2% 条目被判为多源、最多达 9 个信源，
  // 明显虚高（"Trump's EPA data centers" 这类仅共享通用词的条目被误判同源）。
  // 扩充停用词 + 阈值提到 3 后降至 18.5%，抽样确认匹配到的确为同一事件。
  const STOP = new Set(['the','a','an','of','and','or','to','in','for','with','on','is','at','by','as',
    'ai','new','news','www','com','http','https','app','its','it','this','that',
    'more','from','will','can','now','has','have','not','but','are','was','were','been','their','there',
    'what','how','why','who','when','which','than','then','them','they','you','your','our','out','get',
    'just','like','make','made','take','over','into','about','after','before','first','last','year','years',
    'day','days','time','way','old','use','used','using','one','two','also','may','could','would',
    'says','said','want','wants','lets','let','data','model','models','openai','google'])
  // 共享 token 达到该数量才认定为同一事件的多源报道。
  // 调参依据见 docs/source-probe.md：2→47.2%(虚高) / 3→18.5%(合理) / 4→10.6%(偏严)
  const MULTI_SOURCE_MIN_SHARED = 3
  const tokenOf = (t) => new Set(
    ((`${t.title} ${t.summary || ''}`).match(/[A-Za-z][A-Za-z0-9.\-]{1,}|\d+(?:\.\d+)+/g) || [])
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 3 && !STOP.has(s))
  )
  const toks = items.map(tokenOf)
  let multiCount = 0
  for (let i = 0; i < items.length; i++) {
    const rel = new Set(items[i].sources || [items[i].source])
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue
      let shared = 0
      for (const t of toks[i]) { if (toks[j].has(t)) shared++ }
      if (shared >= MULTI_SOURCE_MIN_SHARED) rel.add(items[j].source)
    }
    if (rel.size > 1) { items[i].relatedSources = [...rel]; multiCount++ }
  }
  if (multiCount) console.log(`  ✓ 多源共同报道: ${multiCount} 条`)

  // 5) 统计
  const byCategory = {}, bySource = {}
  for (const it of items) {
    byCategory[it.category] = (byCategory[it.category] || 0) + 1
    bySource[it.source] = (bySource[it.source] || 0) + 1
  }

  const payload = {
    date: dateStr,
    fetchedAt,
    total: items.length,
    byCategory,
    bySource,
    bilibili: (bilibili.ups || []).map((up) => ({
      name: up.name, uid: up.uid, tag: up.tag,
      videos: (up.videos || []).map((v) => {
        // 与并入主列表时一致的真实发布时间
        let vt = v.publishTime ? parseCnDateTime(v.publishTime) : timeUnknown()
        if (!vt.ts) vt = parseUploadDate(v.uploadDate)
        return {
          bvid: v.bvid, title: v.title, url: v.url,
          uploadDate: v.uploadDate, method: v.method, articleUrl: v.articleUrl,
          publishAt: vt.ts, publishPrecision: vt.precision,
          points: (v.news || []).map((n) => ({ title: n.title, summary: n.summary, category: n.category })),
        }
      }),
    })),
    errors: errors.length ? errors : null,
    // 非阻塞问题（正则爬虫失败、B站风控等）：不阻断流程，但要在页面上透明呈现
    warnings: warnings.length ? warnings : null,
    sourceHealth: Object.fromEntries(
      Object.entries(health.sources).map(([k, v]) => [k, {
        lastCount: v.lastCount, lastMs: v.lastMs, failStreak: v.failStreak, unhealthy: v.unhealthy,
      }])),
    items,
  }

  // 6) 落盘（日期文件夹 + 原子写，H-4）
  await writeDay(DATA_DIR, dateStr, payload)

  // 7) 日期索引
  const dates = []
  for (const d of await listDates(DATA_DIR)) {
    const day = await readDay(DATA_DIR, d)
    if (day) dates.push({ date: day.date, total: day.total, fetchedAt: day.fetchedAt })
  }
  dates.sort((a, b) => (a.date < b.date ? 1 : -1))
  await writeJsonAtomic(join(DATA_DIR, 'index.json'), { dates, updatedAt: Date.now() })

  console.log(`\n[aggregate] 完成：${items.length} 条（去重后）`)
  console.log(`  分类: ${JSON.stringify(byCategory)}`)
  console.log(`  来源: ${JSON.stringify(bySource)}`)
  console.log(`  归档: data/${dateStr}/news.json`)
  console.log(`  健康: data/health.json`)
  console.log(`  历史: ${dates.length} 天`)
  if (errors.length) {
    console.log(`  ✗ 源失败（阻断级）: ${errors.length} 项`)
    errors.forEach((e) => console.log(`      - ${e}`))
  }
  if (warnings.length) {
    console.log(`  ⚠ 降级警告（非阻断）: ${warnings.length} 项`)
    warnings.forEach((w) => console.log(`      - ${w}`))
  }
  return 0
}

main().catch((e) => { console.error('[aggregate] 致命错误', e); process.exit(1) })