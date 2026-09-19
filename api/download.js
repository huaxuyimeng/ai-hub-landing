/**
 * api/download.js — GET /api/download?date=&kind=pptx|md&draft=1
 *
 * 读取 /tmp/aihub/out/ 下的 PPTX 或 Markdown 直接流给浏览器。
 * 文件名是中文 → RFC 6266 的 filename*=UTF-8''百分号编码（与本地 serve.mjs 同解法）。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathsFor, isDate, today } from './_lib/kit.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  res.setHeader('Cache-Control', 'no-store')
  const date = isDate(req.query?.date) ? req.query.date : today()
  const kind = req.query?.kind === 'md' ? 'md' : 'pptx'
  const draft = req.query?.draft === '1'
  const f = pathsFor(date, draft)[kind]
  if (!existsSync(f)) { res.status(404).json({ ok: false, error: `文件不存在：${basename(f)}` }); return }
  try {
    const buf = await readFile(f)
    const mime = kind === 'pptx'
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      : 'text/markdown; charset=utf-8'
    const name = basename(f)
    const asciiName = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '')
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Length', String(buf.length))
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`)
    res.status(200).end(buf)
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}
