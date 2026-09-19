/**
 * api/_lib/kit.js — 共享任务执行器（serve.mjs 精简移植，Vercel /tmp 适配版）
 *
 * 为什么单独存在：
 *   serve.mjs 把「HTTP 路由 + 任务状态 + 子进程编排 + 路径解析」混在一起。
 *   本文件只搬「HTTP 路由之外」的部分，通过 --brief / --out 绝对路径适配 /tmp 文件系统，
 *   做到：ai-news-kit/scripts/*.mjs 一行不改；本地 serve.mjs 一行不改。
 *
 * Vercel 适配：
 *   - 产物落 /tmp/aihub（只读 /tmp 之外的目录在 Functions 里会出错）
 *   - /tmp 不是持久化存储；冷启动后任务状态会丢（已知妥协，见 README）
 *   - 单实例执行，单并发队列天然成立
 *
 * 关键环境变量：
 *   AIHUB_TMP         → /tmp/aihub（可覆盖本地调试用）
 *   AIHUB_DATA_DIR    → /tmp/aihub/data（aggregate.mjs 也用这个）
 *   DEEPSEEK_API_KEY  → DeepSeek API Key（用于 Agent 选稿）
 *   DEFAULT_MODEL     → 默认模型，默认 deepseek-chat
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { stat, readFile, mkdir, readdir } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'

// ============== 路径（Vercel 适配） ==============
const TMP_ROOT = process.env.AIHUB_TMP || '/tmp/aihub'
const KIT_ROOT = resolve(process.cwd(), 'ai-news-kit')
const SCRIPTS = join(KIT_ROOT, 'scripts')

// ai-news-kit/scripts/*.mjs（绝对路径，与本地一致）
const AGGREGATE = join(SCRIPTS, 'aggregate.mjs')
const DRAFT = join(SCRIPTS, 'draft-brief.mjs')
const AGENT_PICK = join(SCRIPTS, 'agent-pick.mjs')
const VALIDATE = join(SCRIPTS, 'validate-brief.mjs')
const ANALYZE = join(SCRIPTS, 'analyze.mjs')
const BUILD = join(SCRIPTS, 'build-pptx.mjs')
const MD = join(SCRIPTS, 'brief-to-md.mjs')

// ai-news-kit/data 的 Vercel 替身（/tmp/aihub/data）
const DATA_DIR = process.env.AIHUB_DATA_DIR || join(TMP_ROOT, 'data')

// ⚠ Vercel Function 的 /var/task 是只读，build-pptx 默认写 ${cwd}/AI日报_${date}/...
// 所以我们把所有产物路径都转到 /tmp/aihub/out
const OUT_DIR = join(TMP_ROOT, 'out')

// 启动时确保 /tmp/aihub 及子目录可写
import { mkdirSync } from 'node:fs'
try {
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })
} catch (e) {
  console.error('[kit.js] mkdir /tmp/aihub 失败：', e.message)
}

// 产物路径由 pathsFor() 统一管理，全部指向 /tmp/aihub（Vercel /tmp 可写）
const KIT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(KIT_ROOT, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

// ============== 日期工具 ==============
function today() {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(new Date())
        .map((x) => [x.type, x.value]),
    )
    return `${p.year}-${p.month}-${p.day}`
  } catch {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

// ============== 产物路径（全部指向 /tmp/aihub，Vercel 上 /tmp 可写） ==============
// 本地：默认也走 TMP_ROOT（AIHUB_TMP=D:\...\ai-news-kit\）→ 不污染 ai-hub-landing/ 根
// 之前默认 join(KIT_ROOT, '..', ...) 在 Vercel 上写 /var/task（只读），会导致 build-pptx 失败。
function pathsFor(date, draft) {
  const tag = draft ? '_机器草稿' : ''
  return {
    pptx: join(OUT_DIR, `AI日报_${date}${tag}.pptx`),
    md: join(OUT_DIR, `AI新闻推送_${date}${tag}.md`),
    brief: join(DATA_DIR, date, 'brief.json'),
    draftBrief: join(DATA_DIR, date, 'brief.draft.json'),
    news: join(DATA_DIR, date, 'news.json'),
  }
}

// ============== 子进程（注入 AIHUB_DATA_DIR + 运行时凭证） ==============
function run(argv, opts) {
  opts = opts || {}
  return new Promise((done) => {
    const t0 = Date.now()
    let out = ''
    let err = ''
    // 凭证注入：子进程里 agent-pick.mjs 读 DEEPSEEK_API_KEY / DEFAULT_MODEL
    const env = { ...process.env, AIHUB_DATA_DIR: DATA_DIR }
    if (opts.apiKey) env.DEEPSEEK_API_KEY = opts.apiKey
    if (opts.model) env.DEFAULT_MODEL = opts.model
    const p = spawn(process.execPath, argv, { cwd: KIT_ROOT, env })
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => done({ code: -1, out, err: out + String(e), ms: Date.now() - t0 }))
    p.on('close', (code) => done({ code, out, err, ms: Date.now() - t0 }))
  })
}

// ============== 任务状态（内存 Map） ==============
const jobs = new Map()
const queue = []
let running = false
let seq = 0

const STEP_LABEL = {
  fetch: '抓取信源',
  select: '选稿',
  analyze: '统计图表数据',
  render: '渲染 PPTX',
  pack: '生成 Markdown',
}

function newJob(date, mode, noFetch) {
  const id = `${date}-${String(++seq).padStart(3, '0')}`
  const job = {
    id, date, mode, noFetch: !!noFetch,
    status: 'queued', phase: '排队中',
    createdAt: Date.now(), startedAt: null, finishedAt: null,
    steps: ['fetch', 'select', 'analyze', 'render', 'pack'].map((k) => ({
      key: k, label: STEP_LABEL[k], status: 'pending', ms: null, detail: '',
    })),
    result: null, error: null, selectMode: null, warnings: [],
  }
  jobs.set(id, job)
  queue.push(id)
  pump()
  return job
}

const step = (job, key) => job.steps.find((s) => s.key === key)

async function pump() {
  if (running || !queue.length) return
  running = true
  const job = jobs.get(queue.shift())
  try {
    await execute(job)
  } catch (e) {
    job.status = 'error'
    job.error = String(e && e.message ? e.message : e)
    job.finishedAt = Date.now()
  } finally {
    job.finishedAt = job.finishedAt || Date.now()
    running = false
    setImmediate(pump)
  }
}

async function execute(job) {
  const { date } = job
  const skipFetch = job.noFetch && existsSync(pathsFor(date, false).news)

  job.status = 'running'
  job.startedAt = Date.now()

  // --- ① 抓取 ---
  if (skipFetch) {
    step(job, 'fetch').status = 'skip'
    step(job, 'fetch').detail = '复用已有 news.json（noFetch）'
  } else {
    job.phase = '抓取 10 个数据源…'
    step(job, 'fetch').status = 'running'
    const r = await run([AGGREGATE, '--date', date])
    step(job, 'fetch').ms = r.ms
    if (r.code !== 0) return fail(job, 'fetch', r)
    const m = /完成：(\d+)\s*条/.exec(r.out)
    const blocked = /源失败（阻断级）:\s*(\d+)/.exec(r.out)
    step(job, 'fetch').status = 'done'
    step(job, 'fetch').detail = m ? `去重后 ${m[1]} 条` : '完成'
    if (blocked && Number(blocked[1]) > 0) {
      job.warnings.push(`有 ${blocked[1]} 个信源抓取失败（阻断级），本次日报可能缺料。`)
    }
  }

  // --- ② 选稿 ---
  const P = pathsFor(date, false)
  job.phase = '选稿…'
  step(job, 'select').status = 'running'

  let draft = false

  // 优先用 Agent 选稿（mode=agent 强制，或 mode=auto 有 brief.json）
  const useAgent = job.mode === 'agent' || (job.mode !== 'draft' && existsSync(P.brief))

  if (useAgent) {
    // 确认文件存在（mode=agent 时不存在要报错）
    if (!existsSync(P.brief)) {
      return fail(job, 'select', { code: 1, err: `找不到 Agent 选稿 ${P.brief}。` })
    }
    const r = await run([VALIDATE, '--brief', P.brief])
    step(job, 'select').ms = r.ms
    if (r.code !== 0) return fail(job, 'select', r)
    if (/warning|警告/i.test(r.out)) {
      job.warnings.push('选稿校验有告警（未阻断），详见服务日志。')
    }
    job.selectMode = 'agent'
    step(job, 'select').status = 'done'
    step(job, 'select').detail = 'Agent 选稿 · 校验通过'
  } else if (job.mode === 'draft' || !existsSync(P.brief)) {
    // 降级到机器草稿（mode=draft 或 mode=auto/brief 不存在）
    if (!existsSync(P.news)) return fail(job, 'select', { code: 1, err: '抓取结果缺失，无法生成草稿。' })
    const r = await run([DRAFT, '--date', date, '--news', P.news, '--out', P.draftBrief])
    step(job, 'select').ms = r.ms
    if (r.code !== 0) return fail(job, 'select', r)
    draft = true
    job.selectMode = 'draft'
    job.warnings.push('本次为机器草稿：未经 Agent 选稿与核验，PPT 上带「机器草稿」标记。')
    step(job, 'select').status = 'done'
    step(job, 'select').detail = '机器草稿（无 Agent 选稿）'
  } else if (job.mode === 'agent') {
    // mode=agent 但没有 brief.json → 尝试调 agent-pick.mjs
    if (!existsSync(P.news)) return fail(job, 'select', { code: 1, err: '抓取结果缺失，无法生成选稿。' })
    const creds = getApiCredentials()
    const pickArgs = [AGENT_PICK, '--date', date, '--news', P.news, '--out', P.brief]
    if (creds.model) { pickArgs.push('--model', creds.model) }
    step(job, 'select').status = 'running'
    const r = await run(pickArgs, { apiKey: creds.key, model: creds.model })
    step(job, 'select').ms = r.ms
    if (r.code !== 0) {
      job.warnings.push(`Agent 选稿失败（${r.err || r.out}），降级到机器草稿。`)
      if (!existsSync(P.news)) return fail(job, 'select', { code: 1, err: '抓取结果缺失，无法生成草稿。' })
      const rd = await run([DRAFT, '--date', date, '--news', P.news, '--out', P.draftBrief])
      if (rd.code !== 0) return fail(job, 'select', rd)
      draft = true
      job.selectMode = 'draft'
      job.warnings.push('本次为机器草稿：Agent 选稿失败降级，PPT 上带「机器草稿」标记。')
      step(job, 'select').status = 'done'
      step(job, 'select').detail = '机器草稿（Agent 选稿失败降级）'
    } else {
      job.selectMode = 'agent'
      step(job, 'select').status = 'done'
      step(job, 'select').detail = 'Agent 选稿 · 生成完成'
    }
  }

  const briefFile = draft ? pathsFor(date, true).draftBrief : P.brief

  // --- ③ 统计图表数据 ---
  job.phase = '统计图表数据…'
  step(job, 'analyze').status = 'running'
  const ra = await run([ANALYZE, '--brief', briefFile])
  step(job, 'analyze').ms = ra.ms
  if (ra.code !== 0) {
    step(job, 'analyze').status = 'warn'
    step(job, 'analyze').detail = '失败（PPT 将跳过图表页）'
    job.warnings.push('图表数据统计失败：本次 PPT 会缺少「数据分析」与「模型热度与趋势」两页。')
  } else {
    const m = /语料 (\d+) 条/.exec(ra.out)
    step(job, 'analyze').status = 'done'
    step(job, 'analyze').detail = m ? `语料 ${m[1]} 条` : '完成'
  }

  // --- ④ 渲染 ---
  job.phase = '渲染 PPTX…'
  step(job, 'render').status = 'running'
  // 显式传 --out 写到 OUT_DIR（/tmp/aihub/out）—— build-pptx.mjs 默认写 ${cwd}/...，
  // 在 Vercel 上 ${cwd} = /var/task（只读），会导致渲染失败。
  const rb = await run([BUILD, '--brief', briefFile, '--out', OUT_DIR])
  step(job, 'render').ms = rb.ms
  if (rb.code !== 0) return fail(job, 'render', rb)
  const pagesM = /页数：(\d+)/.exec(rb.out)
  const pages = pagesM ? parseInt(pagesM[1], 10) : null
  const sizeM = /大小：(\d+) KB/.exec(rb.out)
  step(job, 'render').status = 'done'
  step(job, 'render').detail = pages ? `${pages} 页 · ${sizeM ? sizeM[1] + ' KB' : ''}` : '完成'

  // --- ⑤ Markdown ---
  job.phase = '生成 Markdown…'
  step(job, 'pack').status = 'running'
  const outP = pathsFor(date, draft)
  const rm = await run([MD, '--brief', briefFile, '--out', outP.md])
  step(job, 'pack').ms = rm.ms
  if (rm.code !== 0) {
    step(job, 'pack').status = 'warn'
    step(job, 'pack').detail = '失败（PPTX 已产出）'
    job.warnings.push('Markdown 降级版生成失败，PPTX 正常。')
  } else {
    step(job, 'pack').status = 'done'
    step(job, 'pack').detail = '完成'
  }

  // --- 汇总 ---
  const pptxPath = pathsFor(date, draft).pptx
  if (!existsSync(pptxPath)) {
    return fail(job, 'render', { code: 1, err: `渲染脚本报成功但找不到产物：${pptxPath}` })
  }
  const st = await stat(pptxPath)
  const head = await readFile(pptxPath)
  if (head.slice(0, 2).toString('latin1') !== 'PK') {
    return fail(job, 'render', { code: 1, err: '产出的 PPTX magic number 不对，文件可能损坏。' })
  }

  job.status = 'done'
  job.phase = '完成'
  job.result = {
    date, mode: job.selectMode, draft, pages,
    pptx: { name: basename(pptxPath), path: pptxPath, bytes: st.size },
    md: existsSync(pathsFor(date, draft).md)
      ? { name: basename(pathsFor(date, draft).md), path: pathsFor(date, draft).md }
      : null,
  }
  job.finishedAt = Date.now()
}

function fail(job, key, r) {
  const s = step(job, key)
  s.status = 'error'
  s.detail = '失败'
  job.status = 'error'
  job.phase = `${STEP_LABEL[key]}失败`
  const tail = (r.err || r.out || '').split('\n').filter(Boolean).slice(-4).join('\n')
  job.error = tail || `退出码 ${r.code}`
  job.finishedAt = Date.now()
}

// ============== 对外 API ==============

// 运行时注入：generate.js 通过 setApiCredentials() 写入（来自 X-Api-Key / X-Model headers）
var _runtimeApiKey = '';
var _runtimeModel = '';
function setApiCredentials(key, model) {
  _runtimeApiKey = key || '';
  _runtimeModel = model || '';
}
function getApiCredentials() {
  return { key: _runtimeApiKey, model: _runtimeModel }
}
function enqueue(date, mode, noFetch, force) {
  const existing = [...jobs.values()].find(
    (j) => j.date === date && (j.status === 'running' || j.status === 'queued'),
  )
  if (existing && !force) return { job: existing, reused: true }
  const job = newJob(date, mode, noFetch)
  return { job, reused: false }
}

function getJob(id) { return jobs.get(id) }
function queueInfo() { return { busy: running, queued: queue.length } }

async function listHistory() {
  if (!existsSync(DATA_DIR)) return []
  const names = (await readdir(DATA_DIR)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
  names.sort().reverse()
  const out = []
  for (const date of names.slice(0, 60)) {
    const P = pathsFor(date, false)
    const D = pathsFor(date, true)
    const item = { date, hasNews: existsSync(P.news), hasBrief: existsSync(P.brief), hasDraft: existsSync(P.draftBrief), pptx: null, draftPptx: null }
    if (existsSync(P.pptx)) { const s = await stat(P.pptx); item.pptx = { bytes: s.size, mtime: s.mtimeMs } }
    if (existsSync(D.pptx)) { const s = await stat(D.pptx); item.draftPptx = { bytes: s.size, mtime: s.mtimeMs } }
    out.push(item)
  }
  return out
}

function healthInfo() {
  const d = today()
  const P = pathsFor(d, false)
  const D = pathsFor(d, true)
  return {
    ok: true, service: 'ai-news-kit vercel', version: KIT_VERSION,
    node: process.version, now: new Date().toISOString(), today: d,
    busy: running, queued: queue.length,
    todayState: {
      hasNews: existsSync(P.news), hasBrief: existsSync(P.brief),
      hasPptx: existsSync(P.pptx), hasDraftPptx: existsSync(D.pptx),
    },
  }
}

export {
  TMP_ROOT, DATA_DIR, KIT_ROOT, SCRIPTS,
  pathsFor, today, isDate,
  AGGREGATE, DRAFT, AGENT_PICK, VALIDATE, ANALYZE, BUILD, MD,
  enqueue, getJob, queueInfo, listHistory, healthInfo, run,
  setApiCredentials, getApiCredentials,
}
