/**
 * api/generate.js — POST /api/generate
 *
 * ⚠ 同步阻塞版（专为 Vercel Serverless 设计）
 *
 * 为什么同步:
 *   Vercel 每个 Function 调用可能路由到不同实例，跨实例内存 Map 不共享。
 *   异步排队 + 前端轮询 /api/jobs/[id] 会 404。
 *   改为：单次 POST 阻塞等 job 完成（最长 280s）再返回完整结果。
 *   与 Vercel Hobby(10s)/Pro(60s)/Enterprise(300s) maxDuration 兼容（设了 300s）。
 *
 * 入参：{ date?, mode: 'auto'|'agent'|'draft', noFetch?: bool, force?: bool, apiKey?, model? }
 * 出参：{ ok: true, job: { id, status, phase, steps, result, warnings, error } }（200）或 { ok: false, error }（4xx/5xx）
 *
 * 当日去重（用户的 J 需求）：
 *   - 如果今天是同一 date + mode，且已有 PPTX → 跳过抓取/选稿/渲染，直接返回已有结果（"reused" 标记）
 *   - 当天 24 小时内多次点击：第一次真跑，后续复用（但前端依然显示"AI 自动生成中…"动画）
 */
import { enqueue, getJob, isDate, today, pathsFor } from './_lib/kit.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

const MAX_WAIT_MS = 270_000
const POLL_MS = 1500

async function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body)
    let chunks = [], n = 0
    req.on('data', (d) => {
      n += d.length
      if (n > 65536) { req.destroy(); resolve(null); return }
      chunks.push(d)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

async function maybeReuseExisting(date, mode) {
  // 当日已有产物 → 直接复用，避免重复抓取/渲染
  const P = pathsFor(date, false)
  const D = pathsFor(date, true)
  const agentPptx = P.pptx
  const draftPptx = D.pptx
  let reusePath = null
  let reuseMode = null
  if (mode === 'agent' && existsSync(agentPptx)) { reusePath = agentPptx; reuseMode = 'agent' }
  else if (mode === 'draft' && existsSync(draftPptx)) { reusePath = draftPptx; reuseMode = 'draft' }
  else if (mode === 'auto' && existsSync(agentPptx)) { reusePath = agentPptx; reuseMode = 'agent' }
  else if (mode === 'auto' && existsSync(draftPptx)) { reusePath = draftPptx; reuseMode = 'draft' }
  if (!reusePath) return null
  const st = await stat(reusePath)
  const mdPath = reuseMode === 'agent' ? P.md : D.md
  return {
    reused: true,
    job: {
      id: `${date}-REUSED`,
      date,
      mode: reuseMode,
      draft: reuseMode === 'draft',
      status: 'done',
      phase: '完成（复用当日产物）',
      createdAt: Date.now(),
      startedAt: Date.now(),
      finishedAt: Date.now(),
      steps: [
        { key: 'fetch',   label: '抓取信源',     status: 'skip', ms: 0, detail: '复用当日已有数据' },
        { key: 'select',  label: '选稿',         status: 'skip', ms: 0, detail: '复用当日已有选稿' },
        { key: 'analyze', label: '统计图表数据', status: 'skip', ms: 0, detail: '复用当日已有统计' },
        { key: 'render',  label: '渲染 PPTX',    status: 'skip', ms: 0, detail: '复用当日已有 PPTX' },
        { key: 'pack',    label: '生成 Markdown', status: 'skip', ms: 0, detail: '复用当日已有 Markdown' },
      ],
      result: {
        date,
        mode: reuseMode,
        draft: reuseMode === 'draft',
        pages: null,
        pptx: { name: basename(reusePath), path: reusePath, bytes: st.size },
        md: existsSync(mdPath) ? { name: basename(mdPath), path: mdPath } : null,
      },
      warnings: ['本次为复用当日已有产物，未重新抓取/渲染。'],
      error: null,
      selectMode: reuseMode,
    },
  }
}

async function waitJob(job) {
  const t0 = Date.now()
  while (Date.now() - t0 < MAX_WAIT_MS) {
    const cur = getJob(job.id) || job
    if (cur.status === 'done' || cur.status === 'error') return cur
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  // 超时：返回当前状态，前端会显示错误
  job.status = 'error'
  job.phase = '等待超时'
  job.error = `任务在 ${Math.round(MAX_WAIT_MS / 1000)}s 内未完成`
  job.finishedAt = Date.now()
  return job
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: '仅支持 POST' }); return }
  res.setHeader('Cache-Control', 'no-store')

  try {
    const body = await readBody(req)
    if (body === null) { res.status(400).json({ ok: false, error: '请求体不是合法 JSON' }); return }
    const date = isDate(body.date) ? body.date : today()
    const mode = body.mode === 'draft' || body.mode === 'agent' ? body.mode : 'auto'
    const noFetch = !!body.noFetch
    const force = !!body.force

    // 注入凭证（后端用来调 DeepSeek）
    if (body.apiKey || body.model) {
      const { setApiCredentials } = await import('./_lib/kit.js')
      setApiCredentials(body.apiKey, body.model)
    }

    // 当日复用检查（force=true 时跳过）
    if (!force) {
      const reuse = await maybeReuseExisting(date, mode)
      if (reuse) {
        res.status(200).json({ ok: true, reused: true, job: reuse.job })
        return
      }
    }

    // 真正开跑
    const { job: queued } = enqueue(date, mode, noFetch, force)
    // 同步等完成
    const finished = await waitJob(queued)
    // Vercel Serverless 跨实例内存不共享 → /api/download 在新 instance 找不到文件
    // 这里把产物 base64 嵌进 job.result，前端拿到后立刻用 Blob 触发下载
    if (finished.status === 'done' && finished.result) {
      try {
        const pptxPath = finished.result.pptx && finished.result.pptx.path
        const mdPath = finished.result.md && finished.result.md.path
        if (pptxPath && existsSync(pptxPath)) {
          const buf = await readFile(pptxPath)
          finished.result.pptxB64 = buf.toString('base64')
        }
        if (mdPath && existsSync(mdPath)) {
          const buf = await readFile(mdPath)
          finished.result.mdB64 = buf.toString('utf8')
        }
      } catch (e) {
        // 嵌入失败不影响主流程，前端会走 /api/download fallback
        finished.warnings = finished.warnings || []
        finished.warnings.push(`产物内嵌失败：${e.message}（将走 /api/download，可能 404）`)
      }
    }
    res.status(finished.status === 'done' ? 200 : 500).json({ ok: finished.status === 'done', job: finished })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}
