/**
 * api/generate.js — POST /api/generate
 *
 * 入参：{ date?, mode: 'auto'|'agent'|'draft', noFetch?: bool, force?: bool }
 * Headers: X-Api-Key（可选）、X-Model（可选，传递到 kit.js 供 agent-pick 调用 DeepSeek）
 * 出参：{ ok: true, jobId, reused }  （202）
 *
 * 与本地 serve.mjs 同构：当日已有任务在跑 → 直接复用。
 */
import { enqueue, isDate, today } from './_lib/kit.js'

async function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body)
    let chunks = [], n = 0
    req.on('data', (d) => { n += d.length; if (n > 65536) { req.destroy(); resolve(null); return } chunks.push(d) })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
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
    // 注入凭证（后端用来调 DeepSeek；失败走机器草稿降级）
    if (body.apiKey || body.model) {
      const { setApiCredentials } = await import('./_lib/kit.js')
      setApiCredentials(body.apiKey, body.model)
    }
    const { job, reused } = enqueue(date, mode, !!body.noFetch, !!body.force)
    res.status(202).json({ ok: true, jobId: job.id, reused })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}
