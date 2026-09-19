/**
 * 发布时间解析工具集（从 aggregate.mjs 拆出，便于回归测试）。
 *
 * 原则：publishedAt 必须是「新闻/视频的真实发布时间」，绝不用抓取时间冒充。
 * precision：'exact' 有精确时刻 | 'date' 仅日期 | null 未知
 *
 * 可测试性：所有依赖「现在」的函数都接受可选 now 参数（默认 Date.now()）。
 * 没有它就无法为跨年/跨午夜场景写测试——总不能真等到 2027-01-05 再验证。
 *
 * 背景：本轮 4 个缺陷中 3 个出在时间解析（跨年、跨午夜、用抓取时间冒充），
 * 拆出来是为了能补回归测试，见 scripts/test-time.mjs。
 */

export const timeUnknown = () => ({ ts: null, precision: null })

/**
 * 未来时间回退。
 * 源站常只给「月日」或「时分」，需推断年份/日期，可能推到未来：
 *   - 跨年：2027-01-05 抓到 "12月28" → 应回退为 2026-12-28
 *   - 跨午夜：凌晨 00:30 抓到 "23:53" → 应回退为昨天 23:53
 * @param {Date} dt
 * @param {'year'|'day'} unit 回退粒度
 * @param {number} now 可选，便于测试
 */
export function rewindIfFuture(dt, unit, now = Date.now()) {
  // 容差 1 小时：仅容忍时钟/时区误差。
  // 注意不能用「1 天」——否则凌晨 00:30 抓到昨晚 23:53（相差 23.4h）会被误判为容差内而不回退。
  const TOL = 3600000
  if (dt.getTime() - now <= TOL) return dt
  if (unit === 'year') dt.setFullYear(dt.getFullYear() - 1)
  else dt.setDate(dt.getDate() - 1)
  return dt
}

/** 修正 RSS pubDate 的年份错误（aitntnews 源站把年份写成 2001，但月/日/时/分真实） */
export function fixRssYear(raw, now = Date.now()) {
  const d = new Date(raw)
  if (!raw || isNaN(d.getTime())) return timeUnknown()
  const nowY = new Date(now).getFullYear()
  if (d.getFullYear() < nowY - 1) d.setFullYear(nowY)   // 保留月/日/时/分
  rewindIfFuture(d, 'year', now)                        // 跨年兜底
  return { ts: d.getTime(), precision: 'exact' }
}

/** 解析 "2026年8月28日 09:21" / "2026-08-28 09:21" */
export function parseCnDateTime(s) {
  if (!s) return timeUnknown()
  let m = String(s).match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2}):(\d{2}))?/)
  if (!m) m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/)
  if (!m) return timeUnknown()
  const [, y, mo, d, h, mi] = m
  const dt = new Date(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0, 0)
  return { ts: dt.getTime(), precision: h ? 'exact' : 'date' }
}

/** yt-dlp upload_date：YYYYMMDD（仅日期） */
export function parseUploadDate(s) {
  const str = String(s || '')
  if (!/^\d{8}$/.test(str)) return timeUnknown()
  const dt = new Date(+str.slice(0, 4), +str.slice(4, 6) - 1, +str.slice(6, 8))
  return { ts: dt.getTime(), precision: 'date' }
}

/** 当天日期 + HH:MM（如 16:59）；跨午夜自动回退到昨天 */
export function parseTodayHM(hm, now = Date.now()) {
  const m = String(hm || '').match(/(\d{1,2})\s*:\s*(\d{2})/)
  if (!m) return timeUnknown()
  const n = new Date(now)
  const dt = new Date(n.getFullYear(), n.getMonth(), n.getDate(), +m[1], +m[2], 0)
  rewindIfFuture(dt, 'day', now)
  return { ts: dt.getTime(), precision: 'exact' }
}

/** 中文日期 "8月28"，按当前年解析（仅日期）；跨年时自动回退到去年 */
export function parseMonthDay(s, now = Date.now()) {
  const m = String(s || '').match(/(\d{1,2})\s*月\s*(\d{1,2})/)
  if (!m) return timeUnknown()
  const n = new Date(now)
  const dt = new Date(n.getFullYear(), +m[1] - 1, +m[2])
  rewindIfFuture(dt, 'year', now)
  return { ts: dt.getTime(), precision: 'date' }
}
