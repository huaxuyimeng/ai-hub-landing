/**
 * api/history.js — GET /api/history
 *
 * 返回 data/ 下所有日期文件夹的盘点（最多 60 天）。
 * 前端用它填日期下拉框。
 */
import { listHistory } from './_lib/kit.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  res.setHeader('Cache-Control', 'no-store')
  try {
    const items = await listHistory()
    res.status(200).json({ ok: true, items })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) })
  }
}
