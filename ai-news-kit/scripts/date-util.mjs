/**
 * 本地日期工具（aggregate.mjs 与 server.mjs 共用同一实现）。
 *
 * 为什么不用 `new Date().toISOString().slice(0, 10)`：
 *   toISOString() 返回 UTC 时间。在 GMT+8，本地每天 00:00–08:00 期间
 *   UTC 仍是「前一天」，会把当天数据写进前一天的归档文件，
 *   表现为「凌晨抓完，数据看着没更新 / 好像丢了」。
 *
 * 统一走本地时区取日期，两个入口共用，避免实现漂移。
 */

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地日期，格式 YYYY-MM-DD（用于归档文件名、/api/news?date=） */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 本地日期时间，格式 YYYY-MM-DD HH:mm:ss（用于日志） */
export function localDateTime(d = new Date()) {
  return `${localDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 是否为合法归档日期字符串 YYYY-MM-DD */
export function isDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
}
