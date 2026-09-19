/**
 * api/brief.js — GET /api/brief?date=YYYY-MM-DD
 *
 * 让前端在「生成完成」后展示本次选中了哪几条、什么评级。
 * 优先读 brief.json（Agent 选稿），回退 brief.draft.json（机器草稿）。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathsFor, isDate, today } from './_lib/kit.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  res.setHeader('Cache-Control', 'no-store')
  const date = isDate(req.query?.date) ? req.query.date : today()
  for (const draft of [false, true]) {
    const f = draft ? pathsFor(date, true).draftBrief : pathsFor(date, false).brief
    if (!existsSync(f)) continue
    try {
      const b = JSON.parse(await readFile(f, 'utf8'))
      return res.status(200).json({
        ok: true, date, draft, source: basename(f),
        focus: b.focus || [], headline: b.headline || '', stats: b.rawStats || {},
        picks: (b.picks || []).map((x) => ({
          no: x.no, topic: x.topic, title: x.title, lv: x.lv,
          publishedAt: x.publishedAt, srcCount: (x.sources || []).length,
        })),
      })
    } catch (e) {
      return res.status(500).json({ ok: false, error: `选稿解析失败：${e?.message || e}` })
    }
  }
  res.status(404).json({ ok: false, error: `${date} 还没有选稿` })
}
