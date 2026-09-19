/**
 * 归档存储约定（aggregate.mjs 与 server.mjs 共用）。
 *
 * 新约定（2026-08-28 起）：data/YYYY-MM-DD/news.json —— 先生成日期文件夹，再放新闻数据。
 * 兼容：data/YYYY-MM-DD.json 旧平铺文件只读不写（readDay 回退读取）。
 */
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isDateStr } from './date-util.mjs'

export const dayFile = (dataDir, date) => join(dataDir, date, 'news.json')
export const legacyFile = (dataDir, date) => join(dataDir, `${date}.json`)

export async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return null }
}

/** 原子写盘：先写 *.tmp 再 rename，避免并发写截断出半截 JSON */
export async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

/** 写入日期文件夹（先建文件夹，再放数据） */
export async function writeDay(dataDir, date, payload) {
  await mkdir(join(dataDir, date), { recursive: true })
  await writeJsonAtomic(dayFile(dataDir, date), payload)
}

/** 读取：日期文件夹优先，回退旧平铺文件 */
export async function readDay(dataDir, date) {
  if (!isDateStr(date)) return null
  return (await readJson(dayFile(dataDir, date))) ?? (await readJson(legacyFile(dataDir, date)))
}

/** 扫描全部归档日期（日期文件夹 + 旧平铺），倒序 */
export async function listDates(dataDir) {
  const dates = new Set()
  for (const f of await readdir(dataDir, { withFileTypes: true })) {
    if (f.isDirectory() && isDateStr(f.name)) dates.add(f.name)
    else if (f.isFile() && isDateStr(f.name.replace(/\.json$/, ''))) dates.add(f.name.replace(/\.json$/, ''))
  }
  return [...dates].sort().reverse()
}
