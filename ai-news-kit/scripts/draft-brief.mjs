#!/usr/bin/env node
/**
 * news.json → brief.draft.json（**机器草稿**选稿）
 *
 * 为什么需要它：
 *   `build-pptx.mjs` 只认 brief.json，而 brief.json 是 Agent 的判断产物。
 *   用户想「随时点一下按钮就出 PPT」时，Agent 未必在场。这条脚本负责把
 *   「机器能自己确定的那部分」写成一份合法 brief，让渲染链路能跑起来。
 *
 * 机器能确定的：把同一事件的跨源报道聚成一簇、数出有几个独立信源、按规则定级。
 * 机器不能确定的（所以它不做，也不假装做）：
 *   1) 点评。`why` 只陈述可核对的事实边界，并显式标注「机器草稿」——点评是判断。
 *   2) A 级。A 级要求「可追溯到一手官方材料」，要打开原始页面核验，机器做不到，
 *      所以机器草稿的评级上限是 B。
 *   3) 历史查重、跨源数字比对（因此给不出 D 级与冲突结论）。
 *   4) 改写。`event` / `keyFacts` 全部取自聚合源原文，只做 HTML 清洗与长度裁剪。
 *
 * 产物永远是 `brief.draft.json`，**不会覆盖** Agent 写的 `brief.json`；
 * 文件里带 `"draft": true`，渲染器据此在 PPT 封面与页脚加「机器草稿」标记。
 *
 * 用法：
 *   node scripts/draft-brief.mjs --date 2026-09-14
 *   node scripts/draft-brief.mjs --date 2026-09-14 --limit 5 --out data/2026-09-14/brief.draft.json
 *   node scripts/draft-brief.mjs --news path/to/news.json --topics "AI Coding,具身智能"
 *
 * 退出码：0 成功 / 1 候选不足 3 条（不产出，避免造出「半份日报」） / 2 用法错误
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')

// ---------------- 参数 ----------------
// 同时支持 `--date 2026-09-14` 与 `--date=2026-09-14` 两种写法。
const args = process.argv.slice(2)
function getArg(key, def) {
  const eq = args.find((a) => a.startsWith(key + '='))
  if (eq) return eq.slice(key.length + 1)
  const i = args.indexOf(key)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return def
}

const DATE = getArg('--date', null)
if (!DATE) {
  console.error('usage: node scripts/draft-brief.mjs --date YYYY-MM-DD [--news FILE] [--out FILE] [--limit 5] [--topics "A,B"]')
  process.exit(2)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error(`[draft-brief] 日期格式不对：${DATE}（要 YYYY-MM-DD）`)
  process.exit(2)
}

const NEWS = resolve(getArg('--news', join(KIT, 'data', DATE, 'news.json')))
const OUT = resolve(getArg('--out', join(KIT, 'data', DATE, 'brief.draft.json')))
const LIMIT = Math.max(3, Math.min(5, parseInt(getArg('--limit', '5'), 10) || 5))
const BAR = getArg('--topics', '')
const TOPICS = BAR ? BAR.split(',').map((s) => s.trim()).filter(Boolean) : ['AI Coding', '具身智能']

if (!existsSync(NEWS)) {
  console.error(`[draft-brief] 找不到抓取结果：${NEWS}\n  先跑 node scripts/aggregate.mjs --date ${DATE}`)
  process.exit(2)
}

// ---------------- 字段长度预算 ----------------
// 这些数字不是拍脑袋：build-pptx 会在写盘前逐框测量，超一点就 exit 1。
// 所以草稿必须在**源头**就裁到位，而不是指望渲染器兜底（渲染器的职责是拦住错误，不是修内容）。
const BUDGET = {
  title: 84,      // P2 单行框 9.33in@12pt / 详情页 12.13in@19pt 两行
  event: 230,     // 详情页左栏 6.9×1.5in @11pt/1.18 → 6 行
  factEach: 68,   // 关键事实单条
  factTotal: 300, // 关键事实合计
  why: 300,       // 右栏 4.73×3.65in @11pt/1.22 → 14 行
  headline: 150,  // 封面 10.7×0.98in @12pt/1.3 → 3 行
  srcName: 14,    // 来源名（会出现在「来源（N）：」那一行，全行只有 92 字符预算）
  conflicts: 88,  // 「差异与冲突」那一行同样只有一行的高度
  scan: 100,      // 扫读表单行
}

const CONFIDENCE_SCALE = [
  { lv: 'A', name: '极高', rule: '≥3 个独立信源，且可追溯到一手官方材料（官网/论文/公告/官方报告）' },
  { lv: 'B', name: '高', rule: '2 个独立信源，或 1 个信源 + 一手官方材料' },
  { lv: 'C', name: '中', rule: '单一信源报道，细节自洽但无第二方独立印证（含「多家转载同一家独家」）' },
  { lv: 'D', name: '存疑', rule: '关键数字互相矛盾，或全部报道可溯源到同一原始信源且无官方确认' },
]

// ---------------- 工具 ----------------
const ENT = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&hellip;': '…', '&mdash;': '—', '&ndash;': '–', '&middot;': '·', '&times;': '×',
  '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”', '&deg;': '°',
}

function clean(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENT[m.toLowerCase()] ?? ' ')
    .replace(/[\u200b-\u200f\ufeff]/g, '')   // 聚合源里常见的零宽字符
    .replace(/\s+/g, ' ')
    .trim()
}

/** summary 里混着「点击查看原文」这类纯导航文本，必须排除。 */
function usable(s) {
  if (!s || s.length < 60) return false
  if (/^(点击查看原文|阅读原文|查看原文|详情|Read more)/i.test(s)) return false
  return true
}

/**
 * 排除「多则消息拼一条」的每日汇总条目。
 * 聚合源里常见形如「传 iPhone 18 Pro 仅涨价 100 美元；Kimi 将在天猫开店；OpenAI 回应…」
 * 的条目 —— 标题是拼接的、正文写的是另一件事，选进日报会驴唇不对马嘴。
 * 判据：标题里有 3 段以上（即 ≥2 个分号）。
 */
function isDigest(title) {
  return (String(title).match(/[；;]/g) || []).length >= 2
}

/** 截断到上限。优先句末断开，其次逗号，英文再退到词边界 —— 绝不切出「ill-advised to go publi…」这种半截词。 */
function fit(s, max) {
  const t = clean(s)
  if (t.length <= max) return t
  const head = t.slice(0, max)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('！'))
  if (cut > max * 0.5) return head.slice(0, cut + 1)
  const soft = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(','), head.lastIndexOf('.'))
  if (soft > max * 0.6) return head.slice(0, soft + 1) + '…'
  // 纯拉丁文本：退到最后一个空格，避免切断单词
  const sp = head.lastIndexOf(' ')
  if (sp > max * 0.7 && /[A-Za-z]/.test(head.slice(sp))) return head.slice(0, sp).replace(/[,;:.]$/, '') + '…'
  return head.replace(/[\s,，、;；:：]$/, '') + '…'
}

/** 按中文句读切句，保留分隔符。 */
function sentences(s) {
  return clean(s)
    .split(/(?<=[。！？；!?])/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 8)
}

/** 上海时区格式化，绝不落到 UTC —— 否则「09-13 23:30」会被写成 09-13 而实际已是 09-14。 */
const DTF = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})
function localTime(ms) {
  if (!ms) return '未知'
  const parts = Object.fromEntries(DTF.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}
const localDate = (ms) => localTime(ms).slice(0, 10)

// ---------------- 读取 ----------------
const news = JSON.parse(await readFile(NEWS, 'utf8'))
const cfg = existsSync(join(KIT, 'config', 'sources.json'))
  ? JSON.parse(await readFile(join(KIT, 'config', 'sources.json'), 'utf8'))
  : { sources: [] }
const LABEL = Object.fromEntries((cfg.sources || []).map((s) => [s.id, s.label || s.id]))
const TOTAL_SOURCES = (cfg.sources || []).filter((s) => s.enabled !== false).length
const THRESHOLD = cfg.crossSourceTokenThreshold ?? 3

const items = Array.isArray(news.items) ? news.items : []

/**
 * 机器能判定的「独立信源」= aggregate.mjs 写进 relatedSources 的跨源聚合结果
 * （标题级近似匹配，共享实体 token ≥ 阈值）。
 * 注意：`sources` 字段只放本条自己的来源，`relatedSources` 才是聚合结果 —— 别拿错。
 */
function srcIds(it) {
  const r = it.relatedSources
  if (Array.isArray(r) && r.length) return r
  return Array.isArray(it.sources) && it.sources.length ? it.sources : [it.source]
}

// ---------------- ① 跨源聚簇：同一事件的多家报道要合成一簇 ----------------
// 不聚簇就会出洋相：本次实测中「Sam Altman 谈 OpenAI 不上市」被 Verge 与 TechCrunch
// 各写一条，两条都进了正条目，同一件事在日报里出现两次。
function bigrams(s) {
  const t = clean(s).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const g = new Set()
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2))
  return g
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const pool = items
  .map((it) => ({ raw: it, text: clean(it.summary), ids: srcIds(it) }))
  .filter((c) => TOPICS.includes(c.raw.category))
  .filter((c) => usable(c.text))
  .filter((c) => clean(c.raw.title).length >= 10)
  .filter((c) => !isDigest(c.raw.title))
  .sort((a, b) => (b.ids.length - a.ids.length) || ((b.raw.publishedAt || 0) - (a.raw.publishedAt || 0)))

for (const c of pool) c.bg = bigrams(c.raw.title)

// 聚簇判据（阈值来自本项目的实测标定，别凭感觉改）：
//   同事件的一对标题实测相似度 0.768 / 0.560；不同事件的三对是 0.158 / 0.188 / 0.000。
//   所以「标题相似度 ≥ 0.42」是干净的分界线。
//   ⚠ 不要退回「信源集合重叠就判同事件」的写法：同两家媒体各写一篇毫不相关的稿子，
//     信源集合 100% 相同 —— 那个写法会把两周前的旧闻并进今天的事件里（已踩过）。
const TITLE_SAME = 0.42
const TITLE_LOOSE = 0.25
const HOURS_NEAR = 72

const clusters = []
const taken = new Set()
for (const seed of pool) {
  if (taken.has(seed)) continue
  taken.add(seed)
  const members = [seed]
  for (const other of pool) {
    if (taken.has(other)) continue
    const tj = jaccard(seed.bg, other.bg)
    const shared = seed.ids.filter((x) => other.ids.includes(x)).length
    const dtH = Math.abs((seed.raw.publishedAt || 0) - (other.raw.publishedAt || 0)) / 3.6e6
    // 标题几乎一样 → 同事件；标题像 + 至少两家共同信源 + 三天内 → 才认为同事件
    const sameTitle = tj >= TITLE_SAME
    const sameEvent = shared >= 2 && tj >= TITLE_LOOSE && dtH <= HOURS_NEAR
    if (sameTitle || sameEvent) { taken.add(other); members.push(other) }
  }
  // 簇代表：信源最多、其次正文最全 —— 它才是「这件事」的主条目。
  // 用代表自己的发布时间，不用簇内最早时间：后者会被同簇里被转载的旧稿拉到几周前。
  members.sort((a, b) => (b.ids.length - a.ids.length) || (b.text.length - a.text.length))
  const lead = members[0]
  const union = [...new Set(members.flatMap((m) => m.ids))]
  clusters.push({
    lead,
    members,
    sources: union,
    srcCount: union.length,
    at: lead.raw.publishedAt || 0,
    title: clean(lead.raw.title),
    text: lead.text,
    topic: lead.raw.category,
  })
}

// 排序：时效为主、信源数为辅。
// 这一条是项目踩过坑换来的：曾按「信源数」排序，结果 Top N 全是最老的多源稿件，
// 日报变成「本周回顾」。所以时效必须占主导，信源数只做加分（最多 +0.3）。
{
  const ats = clusters.map((c) => c.at).filter(Boolean)
  const maxAt = Math.max(...ats)
  const minAt = Math.min(...ats)
  const span = Math.max(1, maxAt - minAt)
  for (const c of clusters) {
    c.score = (c.at - minAt) / span + 0.3 * (Math.min(c.srcCount, 3) / 3)
  }
  clusters.sort((a, b) => b.score - a.score)
}

// ---------------- ② 选稿：按方向轮转，避免 AI Coding 把 5 个名额全吃掉 ----------------
const byTopic = Object.fromEntries(TOPICS.map((t) => [t, clusters.filter((c) => c.topic === t)]))
const chosen = []
while (chosen.length < LIMIT) {
  const before = chosen.length
  for (const t of TOPICS) {
    if (chosen.length >= LIMIT) break
    const next = byTopic[t].shift()
    if (next) chosen.push(next)
  }
  if (chosen.length === before) break // 所有池子都空了
}
if (chosen.length < 3) {
  console.error(
    `[draft-brief] 可用候选只有 ${chosen.length} 条（少于 3），不产出草稿。\n` +
    `  这通常意味着：① 抓取失败或窗口太窄；② categoryKeywords 与当期内容不匹配。\n` +
    `  按项目纪律「宁可不产出，也不产出半份日报」，此处直接失败。`
  )
  process.exit(1)
}

// ---------------- ③ 组装 picks ----------------
function lvOf(n) {
  // A 级需要「一手官方材料」核验，机器无权判定 → 机器草稿的上限是 B
  return n >= 2 ? 'B' : 'C'
}
const short = (id) => fit(LABEL[id] || id, BUDGET.srcName)

const picks = chosen.map((c, i) => {
  const it = c.lead.raw
  const n = c.srcCount
  const lv = lvOf(n)
  const leadId = it.source
  const others = c.sources.filter((x) => x !== leadId)
  const when = localTime(c.at)

  // keyFacts：优先用原文句子（同一事件簇里取正文最全的那条）
  const kept = []
  let acc = 0
  for (const f of sentences(c.text).slice(0, 4)) {
    const t = fit(f, BUDGET.factEach)
    if (kept.length >= 4 || acc + t.length > BUDGET.factTotal) break
    kept.push(t)
    acc += t.length
  }
  // 原文句子不够时用客观字段补位（来源/时间/分类），不编内容 ——
  // schema 要求 keyFacts ≥3 条，宁可补事实字段也不凑话。
  for (const f of [
    `信源：机器可判定独立信源 ${n} 个（${c.sources.map(short).join('/')}）`,
    `首发时间：${when}`,
    `机器分类：${c.topic}（关键词命中，无人工确认）`,
  ]) {
    if (kept.length >= 3) break
    kept.push(fit(f, BUDGET.factEach))
  }

  const srcNote = n >= 2
    ? `机器聚簇到 ${n} 家信源报道同一事件，形式上够 B 级；但都属转述，一手材料未核验。`
    : `只有 ${short(leadId)} 一家，构不成交叉验证。`

  return {
    no: i + 1,
    topic: c.topic,
    title: fit(c.title, BUDGET.title),
    lv,
    publishedAt: localDate(c.at),
    event: fit(c.text, BUDGET.event),
    keyFacts: kept.slice(0, 4),
    why: fit(
      `【机器草稿 · 非判断】本条由机器按「时效 + 分类」直接选出，点评位留空。` +
      `评级只用了机器能算的那一项：可判定独立信源 ${n} 个。${srcNote}` +
      `要拿到真正的点评与一手核验，需要 Agent 接手重写这份选稿。`,
      BUDGET.why
    ),
    // ⚠ 只放**本条真实链接**。其余信源只有名字、没有独立 URL，
    //    若把它们也塞进 sources 并共用本条 URL，等于伪造了「N 个来源可点」。
    sources: [{
      name: fit(`${LABEL[leadId] || it.sourceLabel || leadId}（本条链接${others.length ? `；另有 ${others.length} 家报道` : ''}）`, 40),
      url: String(it.url || '').replace(/&amp;/g, '&'),
    }],
    conflicts: fit(
      n >= 2
        ? `机器观察到另外 ${others.length} 家报道同一事件（${others.map(short).join('/')}），但未保存其独立链接，故只列为 1 个可用来源。`
        : '单源条目，机器无第二方可比对。',
      BUDGET.conflicts
    ),
  }
})

// ---------------- ④ 扫读清单（同样按簇取，不再出现同事件两条） ----------------
const alsoWorthAScan = clusters
  .filter((c) => !chosen.includes(c))
  .slice(0, 6)
  .map((c) => ({
    title: fit(c.title, BUDGET.scan),
    sources: `${short(c.lead.raw.source)}（${c.srcCount} 源）`,
  }))

// ---------------- ⑤ 统计 ----------------
const byCategory = {}
for (const it of items) byCategory[it.category] = (byCategory[it.category] || 0) + 1
const multiSourceItems = clusters.filter((c) => c.srcCount >= 2).length
const aliveIds = Object.entries(news.sourceHealth || {})
  .filter(([, h]) => h && h.lastCount > 0)
  .map(([id]) => id)
const sourcesAlive = aliveIds.length || new Set(items.map((i) => i.source)).size

const draft = {
  date: DATE,
  draft: true,
  generatedBy: 'machine',
  generatedAt: new Date().toISOString(),
  windowNote:
    `本文件由 draft-brief.mjs 于 ${localTime(Date.now())}（GMT+8）自动生成，` +
    `数据窗口取自 ${localTime(news.fetchedAt)} 抓取的一批条目。`,
  focus: TOPICS,
  headline: fit(
    `【机器草稿】这批内容没有经过 Agent 选稿：${items.length} 条原始条目被机器聚成 ${clusters.length} 件事，` +
    `再按「时效 + 分类」直接挑了 ${picks.length} 条，没有写点评、没有回头核验一手来源、没有做历史查重。` +
    `所以请把它当成「今天有什么在传」，而不是「今天确证了什么」。`,
    BUDGET.headline
  ),
  rawStats: {
    sourcesAlive,
    sourcesTotal: TOTAL_SOURCES,
    rawItems: news.total ?? items.length,
    dedupedItems: clusters.length,
    multiSourceItems,
    byCategory,
    crossSourceThreshold: THRESHOLD,
    note:
      `机器草稿：条目按标题级跨源聚合（共享实体 token ≥${THRESHOLD} + 标题相似度 ≥0.42）聚成 ${clusters.length} 件事，` +
      `其中 ${multiSourceItems} 件有 ≥2 家独立信源（dedupedItems 记的就是这个「事件数」，只统计关注方向且有可用正文的条目）。` +
      `有两件事机器做不了，所以草稿评级上限是 B：A 级要求可追溯到一手官方材料（需打开原始页面核验），` +
      `D 级要求比对各源数字是否矛盾（需逐条读全文）。`,
  },
  confidenceScale: CONFIDENCE_SCALE,
  picks,
  alsoWorthAScan,
  dedupeNote: '机器草稿不做历史查重（需比对往期推送记录），本期内容可能与上一轮重复，请在 Agent 复核时处理。',
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(draft, null, 2) + '\n', 'utf8')

const dist = picks.reduce((a, p) => ((a[p.lv] = (a[p.lv] || 0) + 1), a), {})
console.log(`[draft-brief] 已输出：${OUT}`)
console.log(`[draft-brief] 草稿 ${picks.length} 条（${Object.entries(dist).map(([k, v]) => k + '×' + v).join(' · ') || '—'}）· 原始 ${items.length} 条 → 聚成 ${clusters.length} 件事（多源 ${multiSourceItems}）· 存活源 ${sourcesAlive}/${TOTAL_SOURCES}`)
console.log('[draft-brief] 提醒：这是机器草稿（draft:true），PPT 上会带「机器草稿」标记，不可当正式日报引用。')
