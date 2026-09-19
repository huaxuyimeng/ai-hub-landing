#!/usr/bin/env node
/**
 * 渲染回归测试（07-演进路线 P0-3）
 *
 * 解决的问题：改一行 build-pptx.mjs 可能悄悄破坏版式，只能靠打开 PPT 看。
 *
 * 覆盖：
 *   1. 正常渲染 → 页数公式、文件大小、zip 结构
 *   2. 超长内容 → 必须 fail-fast（exit 1）且**不产出文件**（验证「宁可不产出」纪律）
 *   3. brief 缺失 → exit 2
 *   4. validate-brief 对合法 fixture 通过
 *   5. validate-brief 能抓到业务违规（标 A 但独立源不足）
 *
 * 用法：node scripts/test-render.mjs
 * 退出码：0 全部通过 / 1 有失败
 *
 * ⚠️ 报告写入 tests/test-report.txt 并**带生成时间戳**——
 *    脚本中途异常时报告不会更新，没有时间戳会把上一轮的全绿报告误当本轮结果。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')
const BUILD = join(KIT, 'scripts', 'build-pptx.mjs')
const VALIDATE = join(KIT, 'scripts', 'validate-brief.mjs')
const FIXTURE = join(KIT, 'tests', 'brief.sample.json')
const REPORT = join(KIT, 'tests', 'test-report.txt')
const NODE = process.execPath

if (!existsSync(FIXTURE)) {
  console.error(`[test-render] 缺少 fixture：${FIXTURE}`)
  process.exit(2)
}

/** pptx 是 zip：扫描中央目录里的 ppt/slides/slideN.xml 并去重计数。 */
function countSlides(pptxPath) {
  const buf = readFileSync(pptxPath)
  const s = buf.toString('latin1')
  const m = s.match(/ppt\/slides\/slide\d+\.xml/g) || []
  return new Set(m).size
}

/** zip 中央目录里的条目匹配计数（用于断言「背景图/图表真的写进去了」）。 */
function countEntries(pptxPath, re) {
  const s = readFileSync(pptxPath).toString('latin1')
  return new Set(s.match(re) || []).size
}

const lines = []
let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass++; lines.push(`  OK   ${name}`) }
  else { fail++; lines.push(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'ai-news-kit-test-'))
try {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

  // ---- 1. 正常渲染 ----
  const out1 = join(tmp, 'ok')
  const r1 = spawnSync(NODE, [BUILD, '--brief', FIXTURE, '--out', out1], { encoding: 'utf8' })
  const file1 = join(out1, `AI日报_${fixture.date}.pptx`)
  check('正常用例 exit 0', r1.status === 0, (r1.stderr || '').slice(0, 160))
  check('产出 pptx 文件', existsSync(file1))
  if (existsSync(file1)) {
    const size = readFileSync(file1).length
    check('文件大小 > 40KB', size > 40000, `${size} bytes`)
    // 页数公式：封面 + 速览 + 方法 (3) + 要闻 n + 扫读 + 数据分析 + 模型趋势 + 数据与方法 (4)
    const expect = (fixture.picks || []).length + 7
    const n = countSlides(file1)
    check(`页数 == picks+7（${expect}）`, n === expect, `实际 ${n}`)
    // 背景图：每页铺一张自研渐变 PNG。图片不去重，所以正好 1:1。
    // ⚠ pptxgenjs 的媒体名是 `image-<页>-<序号>.png`（image 后面有个连字符），
    //   写成 /image\d+-\d+/ 会一个都匹配不到 —— 用宽松模式，别再踩这个坑。
    const imgs = countEntries(file1, /ppt\/media\/[A-Za-z0-9._-]+\.png/g)
    check(`背景图 == 页数（${expect}）`, imgs === expect, `实际 ${imgs}`)
    // 图表：置信度 / 分类 / 信源 / 主体提及 / 具身智能主体 / 趋势 = 6 个
    const charts = countEntries(file1, /ppt\/charts\/chart\d+\.xml/g)
    check('图表 == 6 个', charts === 6, `实际 ${charts}`)
    // OOXML 合法性：负 cx/cy 会让 PowerPoint 弹「内容有问题，需要修复」
    const raw = readFileSync(file1).toString('latin1')
    check('无非法负 cx/cy', !/(?:cx|cy)="-\d+"/.test(raw))
  }

  // ---- 1b. 缺 charts 时降级：跳过两页图表页，但仍要出稿（不阻断） ----
  const noCharts = JSON.parse(JSON.stringify(fixture))
  delete noCharts.charts
  const ncFile = join(tmp, 'nocharts.json')
  writeFileSync(ncFile, JSON.stringify(noCharts), 'utf8')
  const outNc = join(tmp, 'nocharts')
  const rNc = spawnSync(NODE, [BUILD, '--brief', ncFile, '--out', outNc], { encoding: 'utf8' })
  const ncOut = join(outNc, `AI日报_${noCharts.date}.pptx`)
  check('缺 charts 仍 exit 0（降级不阻断）', rNc.status === 0, `实际 ${rNc.status}`)
  check('缺 charts 时明确告警', /跳过.*数据分析|没有 charts/.test(rNc.stdout + rNc.stderr))
  if (existsSync(ncOut)) {
    const expectNc = (noCharts.picks || []).length + 5
    check(`缺 charts 页数 == picks+5（${expectNc}）`, countSlides(ncOut) === expectNc, `实际 ${countSlides(ncOut)}`)
  }

  // ---- 2. 超长内容必须 fail-fast 且不产出 ----
  const bad = JSON.parse(JSON.stringify(fixture))
  bad.picks[0].title = '超长标题用于触发溢出校验'.repeat(30)
  const badFile = join(tmp, 'bad.json')
  writeFileSync(badFile, JSON.stringify(bad), 'utf8')
  const out2 = join(tmp, 'bad')
  const r2 = spawnSync(NODE, [BUILD, '--brief', badFile, '--out', out2], { encoding: 'utf8' })
  check('超长内容 exit 1（fail-fast）', r2.status === 1, `实际 ${r2.status}`)
  check('溢出时不产出文件', !existsSync(join(out2, `AI日报_${bad.date}.pptx`)))
  check('报错列出溢出位置', /溢出校验失败/.test(r2.stderr || ''))

  // ---- 3. brief 缺失 → exit 2 ----
  const r3 = spawnSync(NODE, [BUILD, '--brief', join(tmp, 'nope.json'), '--out', join(tmp, 'x')], { encoding: 'utf8' })
  check('brief 不存在 exit 2', r3.status === 2, `实际 ${r3.status}`)

  // ---- 4. 校验器：合法 fixture 通过 ----
  const r4 = spawnSync(NODE, [VALIDATE, '--brief', FIXTURE], { encoding: 'utf8' })
  check('validate-brief 对 fixture exit 0', r4.status === 0, (r4.stderr || '').slice(0, 200))

  // ---- 5. 校验器：能抓到「标 A 但独立源不足」 ----
  const bad2 = JSON.parse(JSON.stringify(fixture))
  bad2.picks[0].lv = 'A'
  bad2.picks[0].sources = [bad2.picks[0].sources[0]]
  const bad2File = join(tmp, 'bad2.json')
  writeFileSync(bad2File, JSON.stringify(bad2), 'utf8')
  const r5 = spawnSync(NODE, [VALIDATE, '--brief', bad2File], { encoding: 'utf8' })
  check('validate-brief 抓到「标A但源不足」', r5.status === 1 && /独立信源/.test(r5.stderr || ''), (r5.stderr || '').slice(0, 160))

  // ---- 6. 校验器：能抓到空话 why ----
  const bad3 = JSON.parse(JSON.stringify(fixture))
  bad3.picks[0].why = '这是重大突破，标志着行业进入新阶段，值得业界高度关注，意义重大，不容忽视。'
  const bad3File = join(tmp, 'bad3.json')
  writeFileSync(bad3File, JSON.stringify(bad3), 'utf8')
  const r6 = spawnSync(NODE, [VALIDATE, '--brief', bad3File], { encoding: 'utf8' })
  check('validate-brief 提示空话 why', /空话/.test(r6.stdout + r6.stderr), (r6.stdout || '').slice(0, 160))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

const header = [
  `ai-news-kit 渲染回归测试`,
  `运行时间：${new Date().toISOString()}（本地 ${new Date().toLocaleString('zh-CN', { hour12: false })}）`,
  `Node：${process.version}  fixture：tests/brief.sample.json`,
  `${'-'.repeat(56)}`,
].join('\n')
const footer = `\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass} passed, ${fail} failed\n`
const report = header + '\n' + lines.join('\n') + footer
writeFileSync(REPORT, report, 'utf8')
console.log(report)
process.exit(fail ? 1 : 0)
