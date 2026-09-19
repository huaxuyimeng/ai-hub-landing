#!/usr/bin/env node
/**
 * brief.json 校验：结构 + 业务规则（07-演进路线 P0-1）
 *
 * 目的：把「渲染时才发现」提前到「写入时就发现」。
 *   结构问题 → 渲染会炸；
 *   业务问题 → 渲染不炸，但会产出**看起来正常、实际违规**的日报（更危险）。
 *
 * 用法：
 *   node scripts/validate-brief.mjs --date 2026-09-14
 *   node scripts/validate-brief.mjs --brief path/to/brief.json
 *
 * 退出码：0 = 无错误（可能有警告）；1 = 有错误；2 = 用法错误
 *
 * 零新依赖：规则针对 schema/brief.schema.json 内联实现，不引入 ajv。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')

const args = process.argv.slice(2)
const getArg = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const DATE = getArg('--date', null)
const BRIEF = getArg('--brief', null)

if (!DATE && !BRIEF) {
  console.error('usage: node scripts/validate-brief.mjs --date YYYY-MM-DD [--brief FILE]')
  process.exit(2)
}
const file = BRIEF ? resolve(BRIEF) : join(KIT, 'data', DATE, 'brief.json')
if (!existsSync(file)) {
  console.error(`[validate-brief] 找不到文件：${file}`)
  process.exit(2)
}

let brief
try {
  brief = JSON.parse(readFileSync(file, 'utf8'))
} catch (e) {
  console.error(`[validate-brief] JSON 解析失败：${e.message}`)
  process.exit(1)
}

const errors = []
const warnings = []
const E = (m) => errors.push(m)
const W = (m) => warnings.push(m)

// ---------------- 结构 ----------------
const req = ['date', 'focus', 'headline', 'rawStats', 'confidenceScale', 'picks']
for (const k of req) if (!brief[k]) E(`缺少顶层字段：${k}`)

if (brief.date && !/^\d{4}-\d{2}-\d{2}$/.test(brief.date)) E(`date 格式应为 YYYY-MM-DD，实际「${brief.date}」`)
if (brief.headline && brief.headline.length < 20) E('headline 过短（<20 字），应为一句话总览')
if (Array.isArray(brief.focus) && brief.focus.length === 0) E('focus 不能为空数组')

const st = brief.rawStats || {}
for (const k of ['sourcesAlive', 'sourcesTotal', 'rawItems', 'multiSourceItems']) {
  if (typeof st[k] !== 'number') E(`rawStats.${k} 必须是数字`)
}
if (typeof st.sourcesAlive === 'number' && typeof st.sourcesTotal === 'number' && st.sourcesAlive < st.sourcesTotal - 2) {
  W(`信源存活 ${st.sourcesAlive}/${st.sourcesTotal}，有 ≥3 源失效时应停止出日报`)
}
if (typeof st.crossSourceThreshold !== 'number') W('rawStats.crossSourceThreshold 缺失（建议写明阈值及其实测依据）')
if (!st.note) W('rawStats.note 缺失（阈值依据会缺省，见 build-pptx 数据与方法页）')

const scale = brief.confidenceScale || []
const lvs = scale.map((c) => c.lv).join('')
if (lvs !== 'ABCD') E(`confidenceScale 应为 A/B/C/D 四项有序排列，实际「${lvs || '空'}」`)

// ---------------- picks ----------------
const picks = brief.picks || []
if (!Array.isArray(picks) || picks.length < 3 || picks.length > 5) {
  E(`picks 应为 3–5 条，实际 ${picks.length} 条（不凑数：少于 3 条应在 dedupeNote 说明）`)
}

const ONE_SOURCE_WORDS = ['一手', '官方', '原始']
const SECONDHAND_WORDS = ['转载', '聚合', '编译', '转述']
const EMPTY_PHRASES = ['值得关注', '重大突破', '意义重大', '标志着', '里程碑', '划时代', '引人注目']

picks.forEach((p, i) => {
  const tag = `picks[${i}]${p.no ? `(第${p.no}条)` : ''}`
  for (const k of ['no', 'topic', 'title', 'lv', 'publishedAt', 'event', 'keyFacts', 'why', 'sources']) {
    if (p[k] === undefined || p[k] === null || p[k] === '') E(`${tag} 缺少字段：${k}`)
  }
  if (p.no !== i + 1) W(`${tag} 序号应为 ${i + 1}，实际 ${p.no}`)
  if (Array.isArray(brief.focus) && p.topic && !brief.focus.includes(p.topic)) {
    W(`${tag} topic「${p.topic}」不在 focus 内（会影响 PPT 配色命中）`)
  }
  if (p.lv && !'ABCD'.includes(p.lv)) E(`${tag} lv 非法：${p.lv}`)
  if (!Array.isArray(p.keyFacts) || p.keyFacts.length < 3) E(`${tag} keyFacts 应 ≥3 条`)
  if (Array.isArray(p.keyFacts) && p.keyFacts.length > 5) W(`${tag} keyFacts 有 ${p.keyFacts.length} 条，PPT 面板建议 ≤5`)

  // 日期：真实发布时间，且不应晚于日报日期
  if (p.publishedAt && brief.date && /^\d{4}-\d{2}-\d{2}/.test(p.publishedAt) && p.publishedAt > brief.date) {
    E(`${tag} publishedAt(${p.publishedAt}) 晚于日报日期(${brief.date})`)
  }

  // why：必须回答「所以呢」，不能是空话
  if (p.why) {
    if (p.why.length < 40) E(`${tag} why 过短（${p.why.length} 字），需要说明对读者决策的影响`)
    const hit = EMPTY_PHRASES.filter((w) => p.why.includes(w))
    if (hit.length) W(`${tag} why 含空话措辞「${hit.join('、')}」，应改写为具体影响`)
  }

  // 来源：一手来源应排第一；评级与独立信源数必须自洽
  const srcs = p.sources || []
  const first = srcs[0]?.name || ''
  const hasPrimary = srcs.some((s2) => ONE_SOURCE_WORDS.some((w) => (s2.name || '').includes(w)))
  const independent = srcs.filter((s2) => !SECONDHAND_WORDS.some((w) => (s2.name || '').includes(w))).length

  if (srcs.length && !ONE_SOURCE_WORDS.some((w) => first.includes(w))) {
    W(`${tag} sources[0]「${first}」未标注一手来源（约定：一手排第一并标注）`)
  }
  if (p.lv === 'A') {
    if (independent < 3) E(`${tag} 标 A 但独立信源仅 ${independent} 个（A 要求 ≥3 个相互独立的信源）`)
    if (!hasPrimary) E(`${tag} 标 A 但无一手来源（官网/论文/公告/官方报告）`)
  }
  if (p.lv === 'B' && independent < 2 && !hasPrimary) {
    E(`${tag} 标 B 但既无 2 个独立信源、也无一手来源`)
  }
  if (p.lv === 'D' && !p.conflicts) W(`${tag} 标 D 但 conflicts 为空（D 通常意味着数字矛盾，应写明）`)
  if (!p.conflicts) W(`${tag} conflicts 为空（无冲突也应写「无实质冲突」）`)

  // 反向检查：全部来源都是转载 → 按规则应降为 C
  if (p.lv !== 'C' && srcs.length > 0 && independent === 0) {
    E(`${tag} 标 ${p.lv}，但所有来源都是转载/聚合（按规则「多家转载同一家独家」只能定 C）`)
  }
})

// 至少应有低置信度条目被显式标注（本项目刻意保留 C/D，用于自证区分度）
if (!picks.some((p) => p.lv === 'C' || p.lv === 'D')) {
  W('本期无 C/D 级条目——若确因证据充分，可忽略；但需确认不是评级被系统性放宽')
}

// ---------------- charts（analyze.mjs 产出的图表数据） ----------------
// charts 缺失**不算错误**：渲染器会跳过两页图表页并告警，其余照常出。
// 但两件事必须一致，否则幻灯片上会出现「标题说 5 条、图里画 4 条」这种自相矛盾：
if (!brief.charts) {
  W('缺少 charts（图表数据）——渲染时会跳过「数据分析」与「模型热度与趋势」两页，跑 node scripts/analyze.mjs 可补上')
} else {
  const c = brief.charts
  const lvCount = {}
  for (const p of picks) lvCount[p.lv] = (lvCount[p.lv] || 0) + 1
  for (const k of ['A', 'B', 'C', 'D']) {
    const want = lvCount[k] || 0
    const got = c.confidence?.[k]
    if (got != null && got !== want) {
      E(`charts.confidence.${k}=${got}，与 picks 实际数量 ${want} 不一致（图表会与要闻页对不上）`)
    }
  }
  if (c.generatedBy !== 'analyze.mjs') {
    W(`charts.generatedBy=${c.generatedBy}，非 analyze.mjs 产出——手写 charts 容易与 picks 脱节`)
  }
  if (!c.corpus?.note) W('charts.corpus.note 为空——图表口径说明（不是全网声量）应显式写在数据页上')
  if (!(c.models?.top || []).length) W('charts.models.top 为空——「模型热度与趋势」页会退化成一句说明')
}

// ---------------- 输出 ----------------
const label = brief.date || file
if (errors.length) {
  console.error(`[validate-brief] ${label} 校验失败：${errors.length} 个错误`)
  errors.forEach((e) => console.error(`  ✗ ${e}`))
}
if (warnings.length) {
  console.warn(`[validate-brief] ${label} 警告：${warnings.length} 条`)
  warnings.forEach((w) => console.warn(`  ! ${w}`))
}
if (!errors.length && !warnings.length) {
  console.log(`[validate-brief] ${label} 校验通过：结构完整，业务规则无异常（${picks.length} 条要闻）`)
} else if (!errors.length) {
  console.log(`[validate-brief] ${label} 校验通过（有 ${warnings.length} 条警告，不阻断）`)
}

process.exit(errors.length ? 1 : 0)
