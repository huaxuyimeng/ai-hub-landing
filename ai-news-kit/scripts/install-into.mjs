#!/usr/bin/env node
/**
 * install-into.mjs —— 把 ai-news-kit 一键插进别的项目
 *
 * 为什么需要它：
 *   「整个目录拷过去就能跑」说起来简单，实际操作要排除 node_modules、历史 data/、
 *   还要把 SKILL.md 放到目标项目的技能目录里。手工做容易漏，漏了就跑不起来。
 *   这个脚本把这件事变成一条命令，并且**拷完立刻自检**，不留下「看起来装好了其实没装好」。
 *
 * 用法：
 *   node scripts/install-into.mjs --target <目标项目根目录> [--mode full|data|spec] [--force]
 *
 * 三种模式：
 *   full  全量接入（默认）：抓取 + 选稿 + 渲染 + 服务 + 文档 + 技能文件
 *   data  只要数据：只拷抓取四件套 + config，零第三方依赖，不用 npm install
 *   spec  只要规范：只拷 SKILL.md + 置信度/数据契约文档，塞进目标项目的技能目录
 *
 * 行为约定：
 *   - 默认**不覆盖**已存在的目标目录（除非 --force）
 *   - 不拷 node_modules / 历史 data / .tmp 等
 *   - 拷完跑自检：检查关键文件齐全 + 抓取脚本能被 node 解析（--check 语法检查）
 *   - 自检失败 exit 1，并打印缺了什么
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------- 参数 ----------------
function getArg(name, def = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const TARGET = getArg('--target')
const MODE = getArg('--mode', 'full')
const FORCE = process.argv.includes('--force')

if (!TARGET) {
  console.error('usage: node scripts/install-into.mjs --target <目标项目根目录> [--mode full|data|spec] [--force]')
  process.exit(2)
}
if (!['full', 'data', 'spec'].includes(MODE)) {
  console.error(`[install-into] 未知 mode: ${MODE}（可选 full / data / spec）`)
  process.exit(2)
}

const targetRoot = resolve(TARGET)
if (!existsSync(targetRoot)) {
  console.error(`[install-into] 目标目录不存在：${targetRoot}`)
  process.exit(2)
}

// ---------------- 复制工具 ----------------
const SKIP_DIR = new Set(['node_modules', '.git', '.tmp', 'tmp', 'coverage'])
const SKIP_FILE = /\.(log|tmp|bak)$/i

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function copyTree(src, dst, filter = null, onFile = null) {
  const st = statSync(src)
  if (st.isDirectory()) {
    ensureDir(dst)
    for (const name of readdirSync(src)) {
      if (SKIP_DIR.has(name)) continue
      copyTree(join(src, name), join(dst, name), filter, onFile)
    }
    return
  }
  if (SKIP_FILE.test(src)) return
  if (filter && !filter(relative(KIT, src))) return
  ensureDir(dirname(dst))
  copyFileSync(src, dst)
  if (onFile) onFile(relative(KIT, src))
}

let count = 0
const bump = () => { count++ }

// ---------------- 各模式 ----------------
const DEST = join(targetRoot, 'tools', 'ai-news-kit')
let skillDir = null

if (MODE === 'full') {
  if (existsSync(DEST) && !FORCE) {
    console.error(`[install-into] 目标已存在：${DEST}\n  加 --force 覆盖，或换个目录。`)
    process.exit(1)
  }
  copyTree(KIT, DEST, (rel) => !rel.startsWith('data' + '/'), bump)

  // data/ 目录要建，但不拷历史数据（别把别人的旧日报带过去）
  ensureDir(join(DEST, 'data'))

  // 技能文件：放进目标项目的 skills 目录，让那边的 Agent 能加载
  skillDir = join(targetRoot, '.workbuddy', 'skills', 'ai-news-kit')
  ensureDir(skillDir)
  copyFileSync(join(KIT, 'SKILL.md'), join(skillDir, 'SKILL.md'))

  console.log(`[install-into] mode=full → ${DEST}`)
  console.log(`[install-into] 技能文件 → ${skillDir}`)
} else if (MODE === 'data') {
  // 只要抓取链路：零第三方依赖
  const scriptsDir = join(DEST, 'scripts')
  ensureDir(scriptsDir)
  ensureDir(join(DEST, 'config'))
  for (const f of ['aggregate.mjs', 'date-util.mjs', 'storage.mjs', 'time-utils.mjs']) {
    copyFileSync(join(KIT, 'scripts', f), join(scriptsDir, f))
    bump()
  }
  copyFileSync(join(KIT, 'config', 'sources.json'), join(DEST, 'config', 'sources.json'))
  bump()
  console.log(`[install-into] mode=data → ${DEST}（零第三方依赖，无需 npm install）`)
} else {
  // spec：只放规范
  skillDir = join(targetRoot, '.workbuddy', 'skills', 'ai-news-kit')
  ensureDir(skillDir)
  copyFileSync(join(KIT, 'SKILL.md'), join(skillDir, 'SKILL.md'))
  bump()
  const docDir = join(skillDir, 'docs')
  ensureDir(docDir)
  for (const d of ['03-置信度评级规则.md', '04-数据契约.md', '02-每日作业手册.md']) {
    const p = join(KIT, 'docs', d)
    if (existsSync(p)) { copyFileSync(p, join(docDir, d)); bump() }
  }
  console.log(`[install-into] mode=spec → ${skillDir}`)
}

console.log(`[install-into] 复制文件 ${count} 个`)

// ---------------- 自检 ----------------
console.log('[install-into] 自检中 …')
const problems = []

if (MODE === 'full' || MODE === 'data') {
  const must = MODE === 'full'
    ? ['package.json', 'scripts/aggregate.mjs', 'scripts/build-pptx.mjs', 'scripts/validate-brief.mjs',
       'scripts/analyze.mjs', 'scripts/serve.mjs', 'config/sources.json', 'config/models.json',
       'schema/brief.schema.json', 'templates/brief.template.json', 'SKILL.md', 'README.md']
    : ['scripts/aggregate.mjs', 'scripts/date-util.mjs', 'scripts/storage.mjs',
       'scripts/time-utils.mjs', 'config/sources.json']

  for (const rel of must) {
    if (!existsSync(join(DEST, rel))) problems.push(`缺少 ${rel}`)
  }

  // 语法检查：确保拷过去的东西 Node 能解析（防半截复制 / 编码损坏）
  const toCheck = MODE === 'full'
    ? ['scripts/aggregate.mjs', 'scripts/build-pptx.mjs', 'scripts/validate-brief.mjs', 'scripts/analyze.mjs']
    : ['scripts/aggregate.mjs']
  for (const rel of toCheck) {
    const p = join(DEST, rel)
    if (!existsSync(p)) continue
    try {
      execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' })
    } catch (e) {
      problems.push(`${rel} 语法检查失败：${String(e.stderr || e.message).split('\n')[0]}`)
    }
  }
}

if (MODE !== 'data') {
  const skillFile = join(skillDir, 'SKILL.md')
  if (!existsSync(skillFile)) problems.push('技能文件 SKILL.md 未写入')
  else {
    const head = readFileSync(skillFile, 'utf8').slice(0, 400)
    if (!head.includes('name:')) problems.push('SKILL.md 缺少 frontmatter（name 字段）')
  }
}

// 写一份接入说明到目标，方便对方项目的人照着跑
if (MODE === 'full') {
  const hint = `# ai-news-kit 接入说明

由 \`ai-news-kit/scripts/install-into.mjs\` 于 ${new Date().toLocaleString('zh-CN')} 写入。

## 跑起来

\`\`\`bash
cd ${relative(targetRoot, DEST).replace(/\\\\/g, '/')}
npm install          # 只装 pptxgenjs
node scripts/aggregate.mjs                 # ① 抓取
cp templates/brief.template.json data/\$(date +%F)/brief.json
#  ② 编辑 brief.json：选稿 + 定级 + 写 why
node scripts/validate-brief.mjs --date YYYY-MM-DD
node scripts/analyze.mjs       --date YYYY-MM-DD
node scripts/build-pptx.mjs    --date YYYY-MM-DD --out ../AI日报_YYYY-MM-DD
\`\`\`

## 三条纪律

1. 置信度只按**独立信源数**判定，转载不算独立信源。
2. \`data/YYYY-MM-DD/brief.json\` 是唯一真相源，渲染脚本只渲染不做判断。
3. 宁可不产出，也不产出「生成一半的 PPT」。

完整文档见同目录 \`docs/\`。
`
  writeFileSync(join(DEST, 'INSTALL-NOTE.md'), hint, 'utf8')
}

if (problems.length) {
  console.error('[install-into] 自检失败：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}

console.log(`[install-into] 自检通过 ✓`)
if (MODE === 'full') {
  console.log(`\n下一步：\n  cd ${DEST}\n  npm install\n  node scripts/aggregate.mjs`)
}
