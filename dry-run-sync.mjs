#!/usr/bin/env node
/**
 * dry-run-sync.mjs — 模拟 Vercel Serverless 调用 /api/generate（同步阻塞版）
 *
 * 验证 generate.js 改完后,产物能被嵌入 base64,前端可以 Blob 下载。
 */
import generate from './api/generate.js'
import { existsSync, readFileSync } from 'node:fs'

const TMP = 'D:\\1Money\\aihub\\ai-hub-landing\\.dryrun-tmp'
process.env.AIHUB_TMP = TMP

function mockReq(body) {
  return {
    method: 'POST',
    body,
    headers: {},
    query: {},
    on: () => {},
  }
}
function mockRes() {
  let status = 200, headers = {}, jsonBody = null, endBuf = null
  const res = {
    status(s) { status = s; return res },
    setHeader(k, v) { headers[k] = v },
    json(o) { jsonBody = o; return res },
    end(b) { if (b) endBuf = b; return res },
    get statusCode() { return status },
    get headers() { return headers },
    get body() { return jsonBody },
    get raw() { return endBuf },
  }
  return res
}

const t0 = Date.now()
console.log(`[dry-run-sync] 日期：2026-09-19`)
console.log(`[dry-run-sync] AIHUB_TMP = ${TMP}`)

const req = mockReq({ date: '2026-09-19', mode: 'auto', noFetch: false, force: true })
const res = mockRes()

try {
  await generate(req, res)
  const ms = Date.now() - t0
  const body = res.body
  console.log(`[dry-run-sync] HTTP ${res.statusCode} · 用时 ${(ms / 1000).toFixed(1)}s`)
  if (!body || !body.ok) {
    console.error('[dry-run-sync] ❌ 失败:', body?.error || '未知错误')
    if (body?.job) console.error(JSON.stringify(body.job, null, 2))
    process.exit(1)
  }
  const job = body.job
  console.log(`[dry-run-sync] 状态：${job.status} · phase=${job.phase}`)
  console.log('[dry-run-sync] 步骤：')
  for (const s of job.steps || []) {
    console.log(`  ${s.key.padEnd(8)} ${s.status.padEnd(8)} ${(s.ms ? (s.ms / 1000).toFixed(1) + 's' : '-').padEnd(8)} ${s.detail || ''}`)
  }
  if (job.result) {
    console.log(`[dry-run-sync] 产物：`)
    console.log(`  PPTX: ${job.result.pptx?.name} · ${job.result.pptx?.bytes} bytes`)
    console.log(`  pptxB64 长度: ${job.result.pptxB64?.length || 0} chars`)
    console.log(`  MD: ${job.result.md?.name || '(无)'}`)
    console.log(`  mdB64 长度: ${job.result.mdB64?.length || 0} chars`)
    if (job.result.pptxB64 && job.result.pptxB64.length > 100000) {
      const buf = Buffer.from(job.result.pptxB64, 'base64')
      console.log(`[dry-run-sync] ✅ base64 解码后 PPTX 大小：${buf.length} bytes · 前 2 字节：${buf.slice(0, 2).toString('latin1')}`)
    }
  }
  if (job.warnings?.length) console.log('[dry-run-sync] 警告：', job.warnings)
} catch (e) {
  console.error('[dry-run-sync] ❌ 异常:', e)
  process.exit(1)
}
