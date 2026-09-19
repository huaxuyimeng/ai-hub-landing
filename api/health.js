/**
 * api/health.js — GET /api/health
 *
 * 与本地 serve.mjs 的 /api/health 完全同构；
 * 前端 generate.js 靠它的 todayState 判断「今天是否有 Agent 选稿」。
 */
import { healthInfo } from './_lib/kit.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json(healthInfo())
}
