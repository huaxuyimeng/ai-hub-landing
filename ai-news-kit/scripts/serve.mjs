#!/usr/bin/env node
/**
 * ai-news-kit · 手动触发生成服务（零依赖，只用 node:http）
 *
 * 存在的理由：
 *   定时（cron）只能覆盖「到点了自动跑」。但真实场景里经常需要**立刻**要一份：
 *   想看今天什么情况、想在开会前出一版、想验证改了配置后的效果。
 *   这条服务把「抓取 → 选稿 → 统计图表数据 → 渲染 → 打包」暴露成一个 HTTP 接口，
 *   任意前端（落地页、仪表盘、curl）点一下就能触发一次真实生成。
 *
 * 设计约束：
 *   1) 只绑 127.0.0.1。这不是公网服务，不做鉴权的前提下绝不监听 0.0.0.0。
 *   2) 单并发 + 队列。渲染会写文件，两个任务并行 = 互相覆盖。
 *   3) 每一步都是真实子进程，进度如实上报。失败就报失败，不返回假进度。
 *   4) 有 Agent 的 brief.json 就用它（agent 模式）；没有才降级到机器草稿（draft 模式），
 *      并把 mode 如实告诉前端 —— 前端据此在界面上区分「已核验」与「草稿」。
 *
 * 用法：
 *   node scripts/serve.mjs                          # 默认 127.0.0.1:8787
 *   node scripts/serve.mjs --port 9000 --out D:/x   # 换端口 / 换产物根目录
 *   node scripts/serve.mjs --selftest --date 2026-09-14   # 跑一次完整链路并打印结果后退出
 *
 * 接口见 docs/09-手动触发生成服务.md
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile, stat, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')
const NODE = process.execPath
const AGG = join(__dirname, 'aggregate.mjs')
const DRAFT = join(__dirname, 'draft-brief.mjs')
const VALIDATE = join(__dirname, 'validate-brief.mjs')
const ANALYZE = join(__dirname, 'analyze.mjs')
const BUILD = join(__dirname, 'build-pptx.mjs')
const MD = join(__dirname, 'brief-to-md.mjs')

const args = process.argv.slice(2)
function getArg(key, def) {
  const eq = args.find((a) => a.startsWith(key + '='))
  if (eq) return eq.slice(key.length + 1)
  const i = args.indexOf(key)
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1]
  return def
}

const PORT = parseInt(getArg('--port', '8787'), 10)
const HOST = getArg('--host', '127.0.0.1')
const OUT_BASE = resolve(getArg('--out', join(KIT, '..')))
const SELFTEST = args.includes('--selftest')

const KIT_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

// ---------------- 日期（必须走本地时区，不能用 toISOString） ----------------
function today() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((x) => [x.type, x.value])
  )
  return `${p.year}-${p.month}-${p.day}`
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

// ---------------- 产物路径（全项目只有这一处定义） ----------------
function pathsFor(date, draft) {
  const dir = join(OUT_BASE, `AI日报_${date}`)
  return {
    pptx: join(dir, draft ? `AI日报_${date}_机器草稿.pptx` : `AI日报_${date}.pptx`),
    md: join(OUT_BASE, draft ? `AI新闻推送_${date}_机器草稿.md` : `AI新闻推送_${date}.md`),
    brief: join(KIT, 'data', date, 'brief.json'),
    draftBrief: join(KIT, 'data', date, 'brief.draft.json'),
    news: join(KIT, 'data', date, 'news.json'),
  }
}

// ---------------- 子进程 ----------------
function run(argv, label) {
  return new Promise((done) => {
    const t0 = Date.now()
    let out = '', err = ''
    const p = spawn(NODE, argv, { cwd: KIT })
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => done({ code: -1, out, err: out + String(e), ms: Date.now() - t0 }))
    p.on('close', (code) => done({ code, out, err, ms: Date.now() - t0 }))
  })
}

// ---------------- 作业 ----------------
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
  const id = `${date}-${(++seq).toString().padStart(3, '0')}`
  const job = {
    id, date, mode, noFetch: !!noFetch,
    status: 'queued', phase: '排队中',
    createdAt: Date.now(), startedAt: null, finishedAt: null,
    steps: ['fetch', 'select', 'analyze', 'render', 'pack'].map((k) => ({ key: k, label: STEP_LABEL[k], status: 'pending', ms: null, detail: '' })),
    result: null, error: null, selectMode: null, warnings: [],
  }
  jobs.set(id, job)
  queue.push(id)
  pump()
  return job
}

function step(job, key) {
  return job.steps.find((s) => s.key === key)
}

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
    const r = await run([AGG, '--date', date])
    step(job, 'fetch').ms = r.ms
    if (r.code !== 0) return fail(job, 'fetch', r)
    // ⚠ 只认总结行「[aggregate] 完成：N 条（去重后）」。
    //    早先写成 /(\d+)\s*条/ 会匹配到第一条逐源日志（如「21 条」），
    //    界面上显示的条数就是某个单源的条数，而不是总数 —— 而且看不出错。
    const m = /完成：(\d+)\s*条/.exec(r.out)
    const blocked = /源失败（阻断级）:\s*(\d+)/.exec(r.out)
    step(job, 'fetch').status = 'done'
    step(job, 'fetch').detail = m ? `去重后 ${m[1]} 条` : '完成'
    if (blocked && Number(blocked[1]) > 0) {
      job.warnings.push(`有 ${blocked[1]} 个信源抓取失败（阻断级），本次日报可能缺料。`)
    }
  }

  // --- ② 选稿：有 Agent 的 brief 就用它，没有才降级 ---
  const P = pathsFor(date, false)
  job.phase = '选稿…'
  step(job, 'select').status = 'running'

  let draft = false
  if (job.mode === 'draft' || !existsSync(P.brief)) {
    if (job.mode === 'agent') {
      return fail(job, 'select', { code: 1, err: `找不到 Agent 选稿 ${P.brief}。要机器草稿请把 mode 设为 draft。` })
    }
    if (!existsSync(P.news)) return fail(job, 'select', { code: 1, err: '抓取结果缺失，无法生成草稿。' })
    const r = await run([DRAFT, '--date', date])
    step(job, 'select').ms = r.ms
    if (r.code !== 0) return fail(job, 'select', r)
    draft = true
    job.selectMode = 'draft'
    job.warnings.push('本次为机器草稿：未经 Agent 选稿与核验，PPT 上带「机器草稿」标记。')
    step(job, 'select').status = 'done'
    step(job, 'select').detail = '机器草稿（无 Agent 选稿）'
  } else {
    const r = await run([VALIDATE, '--brief', P.brief])
    step(job, 'select').ms = r.ms
    // validate 的 warnings 不阻断；只有结构性错误（exit 1/2）才失败
    if (r.code !== 0) return fail(job, 'select', r)
    if (/warning|警告/i.test(r.out)) {
      job.warnings.push('选稿校验有告警（未阻断），详见服务日志。')
    }
    job.selectMode = 'agent'
    step(job, 'select').status = 'done'
    step(job, 'select').detail = 'Agent 选稿 · 校验通过'
  }
  const briefFile = draft ? pathsFor(date, true).draftBrief : P.brief

  // --- ③ 统计图表数据（写回 brief.charts；纯统计，不判断） ---
  // 失败不阻断：缺 charts 时渲染器会跳过两页图表页并告警，其余照常出。
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
  const rb = await run([BUILD, '--brief', briefFile])
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
    // Markdown 是副产物，失败不该让整批作废 —— 但要如实告知
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
  const magicOk = head.slice(0, 2).toString('latin1') === 'PK'
  if (!magicOk) return fail(job, 'render', { code: 1, err: '产出的 PPTX magic number 不对，文件可能损坏。' })

  job.status = 'done'
  job.phase = '完成'
  job.result = {
    date, mode: job.selectMode, draft,
    pages,
    pptx: { name: basename(pptxPath), path: pptxPath, bytes: st.size },
    md: existsSync(pathsFor(date, draft).md) ? { name: basename(pathsFor(date, draft).md), path: pathsFor(date, draft).md } : null,
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

// ---------------- HTTP ----------------
function send(res, code, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(code, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(buf)
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8' })

function readBody(req, limit = 64 * 1024) {
  return new Promise((done) => {
    let n = 0, chunks = []
    req.on('data', (d) => {
      n += d.length
      if (n > limit) { req.destroy(); done(null); return }
      chunks.push(d)
    })
    req.on('end', () => {
      if (!chunks.length) return done({})
      try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { done(null) }
    })
    req.on('error', () => done(null))
  })
}

async function listHistory() {
  const dir = join(KIT, 'data')
  if (!existsSync(dir)) return []
  const names = (await readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
  names.sort().reverse()
  const out = []
  for (const date of names.slice(0, 60)) {
    const P = pathsFor(date, false)
    const D = pathsFor(date, true)
    const item = {
      date,
      hasNews: existsSync(P.news),
      hasBrief: existsSync(P.brief),
      hasDraft: existsSync(P.draftBrief),
      pptx: null, draftPptx: null,
    }
    if (existsSync(P.pptx)) {
      const s = await stat(P.pptx)
      item.pptx = { bytes: s.size, mtime: s.mtimeMs }
    }
    if (existsSync(D.pptx)) {
      const s = await stat(D.pptx)
      item.draftPptx = { bytes: s.size, mtime: s.mtimeMs }
    }
    out.push(item)
  }
  return out
}

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
  const p = u.pathname

  if (req.method === 'OPTIONS') return send(res, 204, '')

  try {
    // --- 健康检查：前端靠它判断「服务在不在、今天有没有料」 ---
    if (p === '/api/health') {
      const d = today()
      const P = pathsFor(d, false)
      const D = pathsFor(d, true)
      return json(res, 200, {
        ok: true,
        service: 'ai-news-kit serve',
        version: KIT_VERSION,
        node: process.version,
        now: new Date().toISOString(),
        today: d,
        busy: running,
        queued: queue.length,
        todayState: {
          hasNews: existsSync(P.news),
          hasBrief: existsSync(P.brief),
          hasPptx: existsSync(P.pptx),
          hasDraftPptx: existsSync(D.pptx),
        },
      })
    }

    if (p === '/api/history') {
      return json(res, 200, { ok: true, items: await listHistory() })
    }

    // --- 触发一次生成 ---
    if (p === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req)
      if (body === null) return json(res, 400, { ok: false, error: '请求体不是合法 JSON' })
      const date = isDate(body.date) ? body.date : today()
      const mode = body.mode === 'draft' || body.mode === 'agent' ? body.mode : 'auto'
      // 同一天已经有任务在跑/排队 → 直接复用，避免用户连点产生多个任务互相踩
      const existing = [...jobs.values()].find((j) => j.date === date && (j.status === 'running' || j.status === 'queued'))
      if (existing && !body.force) {
        return json(res, 200, { ok: true, jobId: existing.id, reused: true })
      }
      const job = newJob(date, mode, body.noFetch)
      return json(res, 202, { ok: true, jobId: job.id, reused: false })
    }

    if (p.startsWith('/api/jobs/')) {
      const id = decodeURIComponent(p.slice('/api/jobs/'.length))
      const job = jobs.get(id)
      if (!job) return json(res, 404, { ok: false, error: `没有这个作业：${id}` })
      return json(res, 200, { ok: true, job })
    }

    // --- 读当期选稿：让前端能显示「生成了哪几条、什么评级」 ---
    if (p === '/api/brief') {
      const date = isDate(u.searchParams.get('date')) ? u.searchParams.get('date') : today()
      for (const draft of [false, true]) {
        const f = draft ? pathsFor(date, true).draftBrief : pathsFor(date, false).brief
        if (!existsSync(f)) continue
        const b = JSON.parse(await readFile(f, 'utf8'))
        return json(res, 200, {
          ok: true, date, draft, source: basename(f),
          focus: b.focus || [], headline: b.headline || '',
          stats: b.rawStats || {},
          picks: (b.picks || []).map((x) => ({ no: x.no, topic: x.topic, title: x.title, lv: x.lv, publishedAt: x.publishedAt, srcCount: (x.sources || []).length })),
        })
      }
      return json(res, 404, { ok: false, error: `${date} 还没有选稿（brief.json / brief.draft.json 都不存在）` })
    }

    // --- 下载 ---
    if (p === '/api/download') {
      const date = isDate(u.searchParams.get('date')) ? u.searchParams.get('date') : today()
      const kind = u.searchParams.get('kind') === 'md' ? 'md' : 'pptx'
      const draft = u.searchParams.get('draft') === '1'
      const f = pathsFor(date, draft)[kind]
      if (!existsSync(f)) return json(res, 404, { ok: false, error: `文件不存在：${basename(f)}` })
      const buf = await readFile(f)
      const mime = kind === 'pptx'
        ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        : 'text/markdown; charset=utf-8'
      // ⚠ 文件名是中文，绝不能直接塞进 filename= —— Node 会抛
      //   ERR_INVALID_CHAR: Invalid character in header content ["Content-Disposition"]，
      //   结果是每次下载都 500，而 curl/浏览器只看到「下载失败」。
      //   正确做法（RFC 6266）：ASCII 兜底名 + filename*=UTF-8''百分号编码的真名。
      const name = basename(f)
      const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
      return send(res, 200, buf, {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      })
    }

    // --- 人肉自检页 ---
    if (p === '/' || p === '/index.html') {
      const d = today()
      const P = pathsFor(d, false)
      return send(res, 200, `<!DOCTYPE html><meta charset="utf-8"><meta name="color-scheme" content="light">
<title>ai-news-kit serve</title>
<style>body{font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#fff;color:#111827;max-width:760px;margin:48px auto;padding:0 24px}
code,pre{font-family:ui-monospace,Consolas,monospace;background:#f1f5f9;border-radius:6px}
pre{padding:12px 14px;overflow:auto;border:1px solid #e5e7eb}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #e5e7eb;padding:6px 10px;text-align:left;font-size:13px}
.mut{color:#6b7280}a{color:#1d4ed8}</style>
<h1>ai-news-kit · 手动生成服务</h1>
<p class="mut">v${KIT_VERSION} · Node ${process.version} · 产物根目录 <code>${OUT_BASE}</code></p>
<h2>今日状态（${d}）</h2>
<table><tr><th>抓取结果</th><td>${existsSync(P.news) ? '有' : '无'}</td></tr>
<tr><th>Agent 选稿</th><td>${existsSync(P.brief) ? '有' : '无'}</td></tr>
<tr><th>正式 PPTX</th><td>${existsSync(P.pptx) ? '有' : '无'}</td></tr></table>
<h2>接口</h2>
<table><tr><th>GET</th><td><a href="/api/health">/api/health</a></td></tr>
<tr><th>GET</th><td><a href="/api/history">/api/history</a></td></tr>
<tr><th>GET</th><td><a href="/api/brief?date=${d}">/api/brief?date=${d}</a></td></tr>
<tr><th>POST</th><td>/api/generate　<code>{"date":"${d}","mode":"auto"}</code></td></tr>
<tr><th>GET</th><td>/api/jobs/&lt;id&gt;</td></tr>
<tr><th>GET</th><td><a href="/api/download?date=${d}&kind=pptx">/api/download?date=${d}&kind=pptx</a></td></tr></table>
<p class="mut">安全边界：只监听 127.0.0.1，无鉴权。不要绑到 0.0.0.0，也不要套公网反代。</p>`, { 'Content-Type': 'text/html; charset=utf-8' })
    }

    return json(res, 404, { ok: false, error: `未知路径：${p}` })
  } catch (e) {
    // 必须留痕：之前这个 catch 静默吞掉 ERR_INVALID_CHAR，
    // 客户端只看到「下载失败」，服务端一行日志都没有，排查全靠猜。
    console.error(`[serve] 处理 ${req.method} ${u.pathname} 出错：${e && e.message}`)
    if (res.headersSent) { try { res.end() } catch {} return }
    return json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
})

// ---------------- 启动 ----------------
if (SELFTEST) {
  const date = isDate(getArg('--date', null)) ? getArg('--date') : today()
  const job = newJob(date, getArg('--mode', 'auto'), false)
  const wait = () => new Promise((r) => {
    const t = setInterval(() => {
      const j = jobs.get(job.id)
      if (j.status === 'done' || j.status === 'error') { clearInterval(t); r(j) }
    }, 300)
  })
  const j = await wait()
  console.log(JSON.stringify({ status: j.status, mode: j.selectMode, result: j.result, warnings: j.warnings, error: j.error, steps: j.steps }, null, 2))
  process.exit(j.status === 'done' ? 0 : 1)
} else {
  server.listen(PORT, HOST, () => {
    console.log(`[serve] ai-news-kit v${KIT_VERSION} · http://${HOST}:${PORT}`)
    console.log(`[serve] 产物根目录：${OUT_BASE}`)
    console.log(`[serve] 只监听本机。API 见 docs/09-手动触发生成服务.md`)
  })
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[serve] 端口 ${PORT} 已被占用。换一个：node scripts/serve.mjs --port ${PORT + 1}`)
      process.exit(1)
    }
    throw e
  })
}
