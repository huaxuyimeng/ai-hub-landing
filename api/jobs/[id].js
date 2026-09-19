/**
 * api/jobs/[id].js — GET /api/jobs/:id
 *
 * ⚠ 已废弃：Vercel Functions 跨实例内存不共享，无法跨调用追踪 job 状态。
 * 请改用 POST /api/generate 的同步阻塞模式（最长 270s）。
 *
 * 这里保留仅为向前兼容：返回 410 Gone + 友好提示。
 */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return }
  res.setHeader('Cache-Control', 'no-store')
  res.status(410).json({
    ok: false,
    error: '本接口在 Vercel 上已废弃。请改用 POST /api/generate 的同步模式（阻塞等完成）。',
    hint: '前端 generate.js 已切换到「提交后一直等，直到拿到完整结果」。',
  })
}
