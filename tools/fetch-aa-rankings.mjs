#!/usr/bin/env node
/**
 * 抓取 Artificial Analysis 首页的实时榜单数据 → 生成落地页可用的数据文件
 *
 * 为什么抓 RSC 流而不是「扣图」：
 *   AA 的图是 ECharts 在浏览器里现画的，页面上**没有静态图片文件可下载**；
 *   热链他们的图既拿不到、也有版权与失效风险。真正可复用的是他们塞在
 *   HTML 里的 JSON-LD 结构化数据（schema.org Dataset，一张图一个 Dataset）。
 *   所以这里「扣」的是数据，图我们自己画 —— 风格与站点一致、可改、永不失效。
 *
 * 数据口径（务必与页面上的声明一致）：
 *   · 智能指数 = Artificial Analysis Intelligence Index（他们自家的评测聚合，0-100）
 *   · 输出速度 = medianOutputSpeed（tokens/s）
 *   · 每任务成本 = costPerIntelligenceIndexTask（美元/任务）
 *   首页每个 Dataset 只带 Top ~11，是**首页图表的口径**，不是全量 314 模型。
 *
 * 用法：
 *   node tools/fetch-aa-rankings.mjs            # 抓取并生成两份产物
 *   node tools/fetch-aa-rankings.mjs --check    # 只测连通性，不写文件
 *
 * 退出码：0 成功 / 1 结构变化（键名对不上，需要人工看） / 2 网络/解析失败
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')

const URL_SOURCE = 'https://artificialanalysis.ai/zh'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const METRIC_NAME = {
  artificialAnalysisIntelligenceIndex: '智能指数',
  medianOutputSpeed: '输出速度',
  costPerIntelligenceIndexTask: '每任务成本',
  input: '输入价',
  output: '输出价',
  cacheHitPrice: '缓存命中价',
  nonCacheInput: '输入价(非缓存)',
  opennessIndex: '开放指数',
}

// 从 RSC 载荷里取配平的 JSON（行与行之间不一定有换行，不能按声明长度截断）
function extractJson(s) {
  let start = -1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') { start = i; break }
  }
  if (start < 0) return null
  const stack = []
  let inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      const top = stack[stack.length - 1]
      if ((top === '{' && c === '}') || (top === '[' && c === ']')) stack.pop()
      if (stack.length === 0) {
        const sub = s.slice(start, i + 1)
        try { return JSON.parse(sub) } catch { return null }
      }
    }
  }
  return null
}

;(async () => {
  console.log(`[aa] 请求 ${URL_SOURCE} …`)
  const r = await fetch(URL_SOURCE, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } })
  if (!r.ok) {
    console.error(`[aa] 首页返回 ${r.status} —— 站点异常或被风控，本轮不写文件。`)
    process.exit(2)
  }
  const html = await r.text()

  // 拼 RSC chunk
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)].map(m => m[1])
  const payload = chunks.map(c => { try { return JSON.parse('"' + c.slice(1, -1) + '"') } catch { return c.slice(1, -1) } }).join('')
  console.log(`[aa] HTML ${Math.round(html.length / 1024)}KB · RSC chunk ${chunks.length} · 载荷 ${Math.round(payload.length / 1024)}KB`)

  // 抽所有 schema.org Dataset（一张图一个）
  const datasets = []
  for (const line of payload.split('\n')) {
    const m = line.match(/^([0-9a-f]+):T([0-9a-f]+),([\s\S]*)$/)
    if (!m) continue
    const j = extractJson(m[3])
    if (!j || j['@type'] !== 'Dataset' || !Array.isArray(j.data)) continue
    datasets.push(j)
  }
  console.log(`[aa] Dataset: ${datasets.map(d => `${d.name}×${d.data.length}`).join(' · ') || '无'}`)
  if (!datasets.length) {
    console.error('[aa] 没抽到任何 Dataset —— 页面结构可能变了，需要人工看 RSC 载荷。')
    process.exit(1)
  }

  // 期望的三个指标必须都在，缺一个都算结构变化（宁可失败也别静默少一张图）
  const want = {
    artificialAnalysisIntelligenceIndex: '智能指数',
    medianOutputSpeed: '输出速度',
    costPerIntelligenceIndexTask: '每任务成本',
  }
  const charts = []
  for (const [key, label] of Object.entries(want)) {
    const ds = datasets.find(d => d.data.some(o => o[key] != null))
    if (!ds) {
      console.error(`[aa] 缺少「${label}」(${key}) —— AA 页面结构变了，需要人工核对。本轮不写文件。`)
      process.exit(1)
    }
    charts.push({
      key,
      label,
      unit: key === 'medianOutputSpeed' ? 'tokens/s' : key === 'costPerIntelligenceIndexTask' ? '$/任务' : '分',
      order: key === 'costPerIntelligenceIndexTask' ? 'asc' : 'desc',   // 成本越低越好，其余越高越好
      items: ds.data
        .filter(o => o[key] != null)
        .map(o => ({ label: o.label, value: +o[key], url: o.detailsUrl ? 'https://artificialanalysis.ai' + o.detailsUrl : null })),
    })
  }

  const snapshot = {
    source: 'Artificial Analysis（artificialanalysis.ai）',
    sourceUrl: URL_SOURCE,
    methodology: 'https://artificialanalysis.ai/methodology',
    fetchedAt: new Date().toISOString(),
    note: '智能指数 = AA 自家评测聚合（0-100）；输出速度 = 中位输出 tokens/s；每任务成本 = 智能指数单任务成本（美元）。首页图表口径，约前 11 名，不是全量模型。',
    charts,
  }

  if (CHECK_ONLY) {
    console.log('[aa] --check 通过，未写文件。')
    console.log(JSON.stringify(snapshot.charts.map(c => ({ label: c.label, n: c.items.length, top1: c.items[0] })), null, 2))
    process.exit(0)
  }

  const dataDir = join(ROOT, 'assets', 'data')
  await mkdir(dataDir, { recursive: true })
  const jsonPath = join(dataDir, 'aa-rankings.json')
  await writeFile(jsonPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')

  // 同步生成一份 JS（落地页是静态站，file:// 下 fetch JSON 会被 CORS 拦，
  // 直接 <script> 引入最稳）
  const jsPath = join(ROOT, 'assets', 'js', 'aa-rankings-data.js')
  await writeFile(jsPath,
    '/* ⚠️ 本文件由 tools/fetch-aa-rankings.mjs 生成，勿手改。数据来源 ' + snapshot.source + ' · 抓取 ' + snapshot.fetchedAt + ' */\n' +
    'window.AA_RANKINGS = ' + JSON.stringify(snapshot, null, 2) + ';\n',
    'utf8')

  const kb = (p) => Math.round(statSync(p).size / 1024)
  console.log(`[aa] 已写出：${jsonPath}（${kb(jsonPath)}KB）`)
  console.log(`[aa] 已写出：${jsPath}（${kb(jsPath)}KB）`)
  charts.forEach(c => console.log(`[aa]   ${c.label}: ${c.items.length} 条 · Top1 ${c.items[0].label} = ${c.items[0].value}`))
})().catch((e) => {
  console.error('[aa] 失败：' + (e && e.message))
  process.exit(2)
})
