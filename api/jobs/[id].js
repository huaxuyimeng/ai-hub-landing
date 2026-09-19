/**
 * api/jobs/[id].js — GET /api/jobs/:id
 *
 * 前端轮询这个接口，每 700ms 一次，看任务进度。
 * 注意：冷启动后任务状态会丢 → 前端应降级到「看产物是否已写盘」。
 */
import { getJob } from '../_lib/kit.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  res.setHeader('Cache-Control', 'no-store')
  const id = req.query?.id
  if (!id) { res.status(400).json({ ok: false, error: '缺少 job id' }); return }
  const job = getJob(id)
  if (!job) { res.status(404).json({ ok: false, error: `没有这个作业：${id}` }); return }
  res.status(200).json({ ok: true, job })
}
