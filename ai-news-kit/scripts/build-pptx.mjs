#!/usr/bin/env node
/**
 * brief.json → .pptx 渲染器（浅色多色渐变底 + 图标 + 原生图表，pptxgenjs）
 *
 * 设计约束（来自项目长期约定，勿改）：
 *   1) 交付物一律**白底浅色** —— 曾做成深色被用户明确纠正过。
 *      现在的渐变底仍属浅色：lib/png.mjs 会断言「最暗通道 ≥ 228」，
 *      不达标直接 exit 1，不让「加了视觉」变成「破了纪律」。
 *   2) 每条要闻必须带置信度与来源，不能只给标题。
 *   3) 宁可不产出，也不产出「生成一半的 PPT」；失败要显式抛错并说明原因。
 *   4) 渲染前做全量溢出校验：任何文本框装不下内容 → exit 1，不写文件。
 *   5) 选稿里若带 draft:true（机器草稿），封面与页脚必须显式标注，且文件名加后缀，
 *      绝不与 Agent 的正式产物混用同一个文件名。
 *   6) **本脚本只渲染，不做任何计算与判断**。图表数据来自 brief.charts
 *      （由 analyze.mjs 统计后写回 brief.json）。若缺 charts 就跳过那两页并告警，
 *      绝不在这里「顺手算一下」—— 那会让渲染器变成第二个真相源。
 *
 * 用法：
 *   node scripts/build-pptx.mjs --date 2026-09-14 [--out D:/xxx] [--brief path/brief.json] [--no-bg]
 *
 * 依赖：pptxgenjs（唯一第三方依赖）
 */
import { readFile, mkdir } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import PptxGenJS from 'pptxgenjs'
import { buildBackgrounds, assertLightEnough } from './lib/png.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KIT = join(__dirname, '..')

const args = process.argv.slice(2)
const getArg = (k, d) => {
  const eq = args.find((a) => a.startsWith(k + '='))
  if (eq) return eq.slice(k.length + 1)
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const DATE = getArg('--date', null)
const BRIEF_PATH = getArg('--brief', null)
const OUT_DIR = getArg('--out', null)
const NO_BG = args.includes('--no-bg')

if (!DATE && !BRIEF_PATH) {
  console.error('usage: node scripts/build-pptx.mjs --date YYYY-MM-DD [--out DIR] [--brief FILE] [--no-bg]')
  process.exit(2)
}

const briefFile = BRIEF_PATH ? resolve(BRIEF_PATH) : join(KIT, 'data', DATE, 'brief.json')
if (!existsSync(briefFile)) {
  console.error(`[build-pptx] 找不到选稿文件：${briefFile}\n  先产出 brief.json（人工选稿或由上游生成），再渲染。`)
  process.exit(2)
}
const brief = JSON.parse(await readFile(briefFile, 'utf8'))
const date = brief.date || DATE

// 机器草稿标记：draft-brief.mjs 产出的选稿会带 draft:true。
// 降级产物必须显式标注（项目纪律：不静默产出、不让人误把草稿当正式日报）。
// 标注落在两处：封面右上角徽标 + 每一页页脚 —— 因为 PPTX 会被单独截图传播，
// 只标封面的话，中间任意一页被截出来就看不出来了。
const IS_DRAFT = brief.draft === true
const DRAFT_TAG = '机器草稿 · 未经 Agent 选稿与核验'

// ---------------- 主题（浅色） ----------------
const C = {
  ink: '111827',      // 主文字
  sub: '4B5563',      // 次要文字
  faint: '6B7280',    // 弱化（不用 9CA3AF：白底只有 2.54:1，不到 AA）
  line: 'E5E7EB',     // 分隔线
  panel: 'F8FAFC',    // 浅底面板
  panel2: 'F1F5F9',
  brand: '4338CA',    // 主色（与落地页 tokens 的 --deep-1 一致）
  coding: '2563EB',
  embodied: '0F766E',
}
// 置信度四色：深蓝 / 青 / 琥珀 / 红 —— 色相相隔拉开，A 与 B 不再都是蓝
const LV = { A: '1D4ED8', B: '0E7490', C: 'B45309', D: 'BE123C' }
const F = '微软雅黑'

// 图表配色（取自落地页色板，同一套色相对外）
const PALETTE = ['4338CA', '0EA5E9', '14B8A6', 'F59E0B', 'BE123C', '6D28D9', '0F766E', 'C2410C']
const TREND_COLORS = ['4338CA', '0E7490', 'B45309', 'BE123C', '0EA5E9']

// 侧重方向：从 brief 读取，不在脚本里写死（换赛道时才不用改代码）
const FOCUS = (Array.isArray(brief.focus) && brief.focus.length ? brief.focus : ['AI Coding', '具身智能']).join(' × ')

const pptx = new PptxGenJS()
pptx.layout = 'LAYOUT_WIDE' // 13.33 x 7.5 in
pptx.author = 'ai-news-kit'
pptx.title = `AI 日报 ${date}`

const W = 13.33, H = 7.5

// ---------------- 背景（多色混色淡渐变，自研 PNG 生成器） ----------------
// pptxgenjs 3.12 不支持渐变填充，所以只能铺一张图。
// ⚠ 图片不会去重：同一张 data URI 被 addImage 几次就写几个 media 文件。
//   因此默认尺寸压到 640×360（纯渐变无细节，放大看不出差别），
//   6 张合计约 128KB，整份 deck 只增加几百 KB。
const BGS = buildBackgrounds(640, 360, 2)
const bgIssues = assertLightEnough(BGS)
if (bgIssues.length) {
  console.error(`[build-pptx] 背景明度不达标，会破坏「白底浅色」约定：\n  ${bgIssues.join('\n  ')}`)
  process.exit(1)
}
const bgURI = (name) => 'image/png;base64,' + (BGS[name] || BGS.body).png.toString('base64')

/** 铺一页背景：先给纯白兜底（图万一没渲染出来也不会变黑），再压上渐变图。 */
function paint(slide, name) {
  slide.background = { color: 'FFFFFF' }
  if (NO_BG) return
  slide.addImage({ data: bgURI(name), x: 0, y: 0, w: W, h: H })
}

// ---------------- 溢出校验：所有文本走这里，写盘前统一测量 ----------------
const registry = []
let currentPage = 0

/** 估算字符串渲染宽度（in）。CJK 全宽，拉丁/数字约 0.55 宽，整体加 5% 安全余量。 */
function textWidthIn(str, fontSizePt) {
  let w = 0
  for (const ch of str) {
    w += (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1.0 : 0.55) * fontSizePt / 72
  }
  return w * 1.05
}

/** 实际行高（in）。微软雅黑单倍行距 ≈ 1.35×字号，再乘 lineSpacingMultiple。 */
function lineH(fontSizePt, mult) {
  return fontSizePt * (mult || 1.2) * 1.35 / 72
}

/**
 * 添加文本并登记测量。text 可为 string 或 rich-text runs 数组。
 * runs 时用 plain 拼接测量。
 */
function T(slide, text, opts) {
  slide.addText(text, opts)
  const plain = Array.isArray(text)
    ? text.map((r) => (typeof r === 'string' ? r : r.text)).join('')
    : String(text ?? '')
  registry.push({ page: currentPage, plain, opts })
}

/** bullet 列表（keyFacts）：runs 按 breakLine 分组还原段落，逐段折行累计测量。 */
function Tbullets(slide, runs, opts) {
  slide.addText(runs, opts)
  const { w } = opts
  const fontSize = opts.fontSize || 10
  const mult = opts.lineSpacingMultiple || 1.2
  const lh = lineH(fontSize, mult)
  const paras = []
  let cur = ''
  for (const r of runs) {
    cur += (typeof r === 'string' ? r : r.text)
    if (r.options && r.options.breakLine) { paras.push(cur); cur = '' }
  }
  if (cur) paras.push(cur)
  let need = 0
  for (const t of paras) {
    const lines = Math.max(1, Math.ceil(textWidthIn(t, fontSize) / (w - 0.25)))
    need += lines * lh
  }
  registry.push({ page: currentPage, plain: paras.join(' '), opts, customNeedH: need })
}

/** 渲染完成后统一校验；返回溢出清单。 */
function findOverflows() {
  const bad = []
  for (const r of registry) {
    const { y, w, h } = r.opts
    const fontSize = r.opts.fontSize || 11
    const mult = r.opts.lineSpacingMultiple || 1.2
    const lines = Math.max(1, Math.ceil(textWidthIn(r.plain, fontSize) / w))
    const needH = r.customNeedH ?? lines * lineH(fontSize, mult)
    if (needH > h + 0.02) {
      bad.push({ page: r.page, plain: r.plain.slice(0, 40), needH: +needH.toFixed(2), h })
    } else if (y + needH > H - 0.1) {
      bad.push({ page: r.page, plain: r.plain.slice(0, 40), needH: +(y + needH).toFixed(2), h: '越出页底' })
    }
  }
  return bad
}

// ---------------- 绘图原语 ----------------
/**
 * 线段。⚠ 必须把坐标正规化成「非负宽高 + flipH/flipV」。
 * 直接把 dx/dy 当 w/h 传（其一为负）时 pptxgenjs 会写出
 * `<a:ext cx="-914400">` —— 这违反 OOXML（cx/cy 必须非负），
 * PowerPoint 打开时可能直接弹「内容有问题，需要修复」。
 */
function seg(s, x1, y1, x2, y2, color, widthPt) {
  s.addShape(pptx.ShapeType.line, {
    x: Math.min(x1, x2), y: Math.min(y1, y2),
    w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
    flipH: x2 < x1, flipV: y2 < y1,
    line: { color, width: widthPt },
  })
}

const sh = (s, name, x, y, w, h, o = {}) => s.addShape(pptx.ShapeType[name], { x, y, w, h, ...o })
const solid = (s, name, x, y, w, h, color, o = {}) =>
  s.addShape(pptx.ShapeType[name], { x, y, w, h, fill: { color }, ...o })
/** 描边（填充设成全透明，否则会在背景上盖一块白） */
const stroke = (s, name, x, y, w, h, color, width, o = {}) =>
  s.addShape(pptx.ShapeType[name], { x, y, w, h, fill: { color: 'FFFFFF', transparency: 100 }, line: { color, width }, ...o })

/** 圆角底板（面板） */
function panel(s, x, y, w, h, { fill = C.panel, line = C.line, radius = 0.06 } = {}) {
  solid(s, 'roundRect', x, y, w, h, fill, { rectRadius: radius, line: { color: line, width: 0.75 } })
}

// ---------------- 图标库 ----------------
// 全部用 pptxgenjs 自带形状拼，不依赖图标字体/外部图片：
//   1) 字体图标在中文字体环境下经常缺字形（会显示成方框）；
//   2) 外部 SVG 要额外处理转换，破坏「clone 即可跑」。
// 坐标用 0–100 的网格，最后按 size(u) 换算，改尺寸不用改图形。
// ⚠ 辅助函数签名统一为 (形状名, x, y, w, h, 颜色, 圆角, 额外选项)：
//   颜色在圆角之前 —— 之前写成 (…, 圆角, 颜色) 时，
//   `g.fill('ellipse', 37,40,9,9, '#FFF')` 会被当成 rectRadius='#FFF' → NaN。
const ICON_SET = {
  /* 代码：< / > */
  code(g) {
    g.seg(38, 20, 16, 50); g.seg(16, 50, 38, 80)
    g.seg(62, 20, 84, 50); g.seg(84, 50, 62, 80)
    g.seg(53, 16, 47, 84, 7)
  },
  /* 机器人：具身智能 */
  robot(g) {
    g.seg(50, 30, 50, 14, 8)
    g.dot(45, 4, 10, 10)
    g.fill('roundRect', 26, 26, 48, 46, null, 11)
    g.fill('rect', 14, 42, 10, 14)
    g.fill('rect', 76, 42, 10, 14)
    g.fill('ellipse', 37, 40, 10, 10, g.bg)
    g.fill('ellipse', 54, 40, 10, 10, g.bg)
    g.fill('rect', 38, 58, 24, 5, g.bg)
  },
  /* 芯片：模型 / 算力 */
  chip(g) {
    g.fill('roundRect', 26, 26, 48, 48, null, 8)
    g.fill('roundRect', 40, 40, 20, 20, g.bg, 4)
    for (const v of [36, 47, 58]) {
      g.fill('rect', v, 14, 6, 12)
      g.fill('rect', v, 74, 6, 12)
      g.fill('rect', 14, v, 12, 6)
      g.fill('rect', 74, v, 12, 6)
    }
  },
  /* 网络：信源与交叉验证 */
  network(g) {
    g.seg(50, 50, 22, 24, 7)
    g.seg(50, 50, 80, 26, 7)
    g.seg(50, 50, 50, 84, 7)
    g.dot(42, 42, 16, 16)
    g.dot(14, 16, 16, 16)
    g.dot(72, 18, 16, 16)
    g.dot(42, 76, 16, 16)
  },
  /* 盾牌 + 对勾：核验 / 方法 */
  shield(g) {
    g.fill('roundRect', 28, 14, 44, 40, null, 12)
    g.fill('triangle', 28, 44, 44, 34, null, 0, { rotate: 180 })
    g.seg(41, 40, 48, 49, 9, g.bg)
    g.seg(48, 49, 61, 30, 9, g.bg)
  },
  /* 三角形警示：存疑 / 注意 */
  warn(g) {
    g.fill('triangle', 24, 20, 52, 48)
    g.fill('rect', 47, 32, 6, 20, g.bg, 2)
    g.dot(47, 56, 6, 6, g.bg)
  },
  /* 三根柱子：数据分析 */
  bars(g) {
    g.fill('roundRect', 20, 56, 16, 30, null, 4)
    g.fill('roundRect', 42, 36, 16, 50, null, 4)
    g.fill('roundRect', 64, 20, 16, 66, null, 4)
  },
  /* 折线向上 + 箭头：趋势 */
  trend(g) {
    g.seg(16, 74, 38, 52, 8)
    g.seg(38, 52, 56, 64, 8)
    g.seg(56, 64, 82, 30, 8)
    g.fill('triangle', 74, 12, 22, 20)
  },
  /* 时钟：时效 */
  clock(g) {
    g.stroke('ellipse', 12, 12, 76, 76, 9)
    g.seg(50, 50, 50, 24, 8)
    g.seg(50, 50, 70, 60, 8)
  },
  /* 清单 */
  list(g) {
    const ys = [24, 48, 72]
    const ws = [64, 52, 44]
    ys.forEach((y, i) => {
      g.dot(10, y - 5, 11, 11)
      g.fill('roundRect', 30, y - 5, ws[i], 10, null, 5)
    })
  },
  /* 靶心：精选 */
  target(g) {
    g.stroke('ellipse', 8, 8, 84, 84, 8)
    g.stroke('ellipse', 30, 30, 40, 40, 8)
    g.dot(44, 44, 12, 12)
  },
  /* 闪电：速度 / 热度 */
  bolt(g) { g.fill('lightningBolt', 26, 8, 48, 84) },
  /* 链条：一手来源 */
  link(g) {
    g.stroke('roundRect', 10, 38, 48, 26, 8)
    g.stroke('roundRect', 42, 38, 48, 26, 8)
  },
  /* 叠层：分类 */
  layers(g) {
    g.fill('roundRect', 20, 14, 60, 20, null, 6)
    g.fill('roundRect', 14, 41, 72, 20, null, 6)
    g.fill('roundRect', 20, 68, 60, 20, null, 6)
  },
  /* 文档 */
  doc(g) { g.fill('flowChartDocument', 22, 12, 56, 76) },
  /* 齿轮：方法 / 机制 */
  gear(g) { g.fill('gear6', 12, 12, 76, 76) },
  /* 星：极高置信 */
  star(g) { g.fill('star5', 10, 12, 80, 76) },
  /* 对勾 */
  check(g) { g.seg(24, 52, 43, 72, 11); g.seg(43, 72, 78, 28, 11) },
}

/**
 * 画图标。x/y 是左上角，size 是边长（英寸）。
 * 坐标用 0–100 网格；线宽也按网格单位给，由 u 换算成 pt ——
 * 否则同一图标换尺寸时线宽不变，小尺寸下会糊成一团。
 * 白色部分（眼睛、对勾、感叹号）用 g.bg，在浅色底上天然形成「镂空」观感。
 */
function icon(s, name, x, y, size, color) {
  const fn = ICON_SET[name]
  if (!fn) return
  const u = size / 100
  const g = {
    bg: 'FFFFFF',
    // (形状名, x, y, w, h, 颜色, 圆角, 额外选项) —— 颜色在圆角之前
    fill: (n, gx, gy, gw, gh, col, r, o = {}) =>
      s.addShape(pptx.ShapeType[n], {
        x: x + gx * u, y: y + gy * u, w: gw * u, h: gh * u,
        fill: { color: col || color },
        ...(r ? { rectRadius: r * u } : {}), ...o,
      }),
    dot: (gx, gy, gw, gh, col) =>
      s.addShape(pptx.ShapeType.ellipse, {
        x: x + gx * u, y: y + gy * u, w: gw * u, h: gh * u,
        fill: { color: col || color },
      }),
    // wGrid 是网格单位（不是 pt），这里换算成 pt
    stroke: (n, gx, gy, gw, gh, wGrid = 8, col) =>
      s.addShape(pptx.ShapeType[n], {
        x: x + gx * u, y: y + gy * u, w: gw * u, h: gh * u,
        fill: { color: 'FFFFFF', transparency: 100 },
        line: { color: col || color, width: wGrid * u * 72 },
      }),
    seg: (x1, y1, x2, y2, wGrid = 9, col) => {
      const ax = x + x1 * u, ay = y + y1 * u, bx = x + x2 * u, by = y + y2 * u
      s.addShape(pptx.ShapeType.line, {
        x: Math.min(ax, bx), y: Math.min(ay, by),
        w: Math.abs(bx - ax), h: Math.abs(by - ay),
        flipH: bx < ax, flipV: by < ay,
        line: { color: col || color, width: wGrid * u * 72 },
      })
    },
  }
  fn(g)
}

/** 圆角彩色底板 + 白色图标：给页眉、统计卡用的「徽标」画法 */
function iconBadge(s, name, x, y, size, color) {
  solid(s, 'roundRect', x, y, size, size, color, { rectRadius: size * 0.26 })
  icon(s, name, x + size * 0.22, y + size * 0.22, size * 0.56, 'FFFFFF')
}

// ---------------- 通用版式 ----------------
const TOTAL_PAGES = ((brief.picks || []).length || 0) + 7

function footer(slide, page) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: H - 0.62, w: W - 1.2, h: 0.012, fill: { color: C.line } })
  slide.addText(`AI 日报 · ${date} · 侧重 ${FOCUS}${IS_DRAFT ? ' · 机器草稿' : ''}`, {
    x: 0.6, y: H - 0.55, w: 8, h: 0.3,
    fontFace: F, fontSize: 9, color: C.faint, valign: 'middle',
  })
  if (IS_DRAFT) {
    slide.addShape(pptx.ShapeType.roundRect, {
      x: W - 4.5, y: H - 0.58, w: 1.95, h: 0.28, rectRadius: 0.14,
      fill: { color: 'FEF3C7' }, line: { color: 'F59E0B', width: 0.75 },
    })
    slide.addText('机器草稿', {
      x: W - 4.5, y: H - 0.58, w: 1.95, h: 0.28,
      fontFace: F, fontSize: 8, bold: true, color: '92400E', align: 'center', valign: 'middle',
    })
  }
  slide.addText(`${page} / ${TOTAL_PAGES}`, {
    x: W - 1.7, y: H - 0.55, w: 1.1, h: 0.3,
    fontFace: F, fontSize: 9, color: C.faint, align: 'right', valign: 'middle',
  })
}

/** 页眉：小图标 + kicker + 大标题 */
function header(slide, kicker, title, iconName, accent = C.brand) {
  if (iconName) iconBadge(slide, iconName, 0.6, 0.38, 0.42, accent)
  const tx = iconName ? 1.16 : 0.6
  slide.addText(kicker, { x: tx, y: 0.4, w: W - tx - 0.6, h: 0.26, fontFace: F, fontSize: 10.5, color: accent, bold: true })
  slide.addText(title, { x: tx, y: 0.66, w: W - tx - 0.6, h: 0.5, fontFace: F, fontSize: 22, bold: true, color: C.ink })
}

/** 图表/模块小标题（带图标） */
function sectionLabel(slide, x, y, w, label, iconName, color = C.sub) {
  if (iconName) icon(slide, iconName, x, y + 0.015, 0.2, color)
  slide.addText(label, {
    x: x + (iconName ? 0.28 : 0), y, w: w - (iconName ? 0.28 : 0), h: 0.24,
    fontFace: F, fontSize: 10.5, bold: true, color,
  })
}

/** 去掉上游文案里的 Markdown 强调标记。
 *  pptxgenjs 不解析 Markdown，`**粗体**` 在幻灯片上就是字面的星号 ——
 *  brief/analyze 里为了在 md 版本好看会写 `**`，渲染前必须剥掉。 */
const md = (s) => String(s || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*\*/g, '')

/** 把文本里的数字段拆成 rich runs：数字加粗着色，其余正常。 */
function withNumRuns(text, baseColor, numColor, extra = {}) {
  const runs = []
  const re = /\d+(?:[.,]\d+)*(?:%|km|x)?/g
  let last = 0, m
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), options: { color: baseColor, ...extra } })
    runs.push({ text: m[0], options: { color: numColor, bold: true, ...extra } })
    last = m.index + m[0].length
  }
  if (last < text.length) runs.push({ text: text.slice(last), options: { color: baseColor, ...extra } })
  return runs.length ? runs : [{ text, options: { color: baseColor, ...extra } }]
}

// 图表通用样式
const chartBase = {
  fontFace: F,
  catAxisLabelFontSize: 9.5,
  catAxisLabelColor: C.sub,
  catAxisLineShow: false,
  catGridLine: { style: 'none' },
  valAxisLabelFontSize: 9,
  valAxisLabelColor: C.faint,
  valGridLine: { style: 'none' },
  chartArea: { fill: { color: 'FFFFFF', transparency: 100 }, border: { pt: 0, color: 'FFFFFF' } },
}

// ---------------- P1 封面 ----------------
currentPage = 1
{
  const s = pptx.addSlide()
  paint(s, 'cover')
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: H, fill: { color: C.brand } })
  s.addText('AI 日报', { x: 0.95, y: 0.8, w: 8, h: 0.6, fontFace: F, fontSize: 20, color: C.brand, bold: true })
  if (IS_DRAFT) {
    s.addShape(pptx.ShapeType.roundRect, {
      x: 2.35, y: 0.91, w: 4.15, h: 0.36, rectRadius: 0.18,
      fill: { color: 'FEF3C7' }, line: { color: 'F59E0B', width: 1 },
    })
    s.addText(DRAFT_TAG, {
      x: 2.35, y: 0.91, w: 4.15, h: 0.36,
      fontFace: F, fontSize: 10, bold: true, color: '92400E', align: 'center', valign: 'middle',
    })
  }
  s.addText(date, { x: 0.95, y: 1.4, w: 10, h: 1.0, fontFace: F, fontSize: 46, bold: true, color: C.ink })
  s.addText(`侧重方向：${FOCUS}`, { x: 0.95, y: 2.48, w: 10, h: 0.4, fontFace: F, fontSize: 16, color: C.sub })

  // 统计卡（带图标）
  const st = brief.rawStats || {}
  const stats = [
    { k: '原始条目', v: String(st.rawItems ?? '—'), u: '条', ic: 'doc' },
    { k: '存活信源', v: `${st.sourcesAlive ?? '—'}/${st.sourcesTotal ?? '—'}`, u: '个', ic: 'network' },
    { k: '多源共同报道', v: String(st.multiSourceItems ?? '—'), u: '条', ic: 'link' },
    { k: '精选要闻', v: String((brief.picks || []).length), u: '条', ic: 'target' },
  ]
  stats.forEach((it, i) => {
    const x = 0.95 + i * 2.88
    panel(s, x, 3.18, 2.72, 1.28)
    icon(s, it.ic, x + 0.22, 3.42, 0.3, C.brand)
    s.addText(it.k, { x: x + 0.64, y: 3.4, w: 1.95, h: 0.3, fontFace: F, fontSize: 10, color: C.sub, valign: 'middle' })
    T(s, [
      { text: it.v, options: { fontSize: 22, bold: true, color: C.ink } },
      { text: ' ' + it.u, options: { fontSize: 9.5, color: C.faint } },
    ], { x: x + 0.22, y: 3.72, w: 2.4, h: 0.5, fontFace: F, valign: 'middle' })
  })

  // 置信度分布迷你条（带图标）
  const conf = brief.charts?.confidence
  if (conf) {
    const total = Object.values(conf).reduce((a, b) => a + b, 0) || 1
    let cx = 0.95
    icon(s, 'shield', 0.95, 4.66, 0.26, C.brand)
    s.addText('本期置信度分布', { x: 1.3, y: 4.64, w: 3, h: 0.3, fontFace: F, fontSize: 10.5, bold: true, color: C.sub, valign: 'middle' })
    cx = 3.1
    for (const lv of ['A', 'B', 'C', 'D']) {
      const n = conf[lv] || 0
      const bw = 0.62 + (n / total) * 2.2
      s.addShape(pptx.ShapeType.roundRect, {
        x: cx, y: 4.66, w: bw, h: 0.28, rectRadius: 0.08, fill: { color: LV[lv] },
      })
      s.addText(`${lv}×${n}`, {
        x: cx, y: 4.66, w: bw, h: 0.28, fontFace: F, fontSize: 9, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
      })
      cx += bw + 0.12
    }
  }

  // 今日一句话
  panel(s, 0.95, 5.16, 11.4, 1.28, { fill: 'FFFFFF' })
  s.addShape(pptx.ShapeType.rect, { x: 0.95, y: 5.16, w: 0.055, h: 1.28, fill: { color: C.brand } })
  T(s, brief.headline || '', {
    x: 1.3, y: 5.32, w: 10.7, h: 0.98, fontFace: F, fontSize: 12, color: C.ink,
    valign: 'top', lineSpacingMultiple: 1.3,
  })

  T(s, '置信度评级只按「独立信源数」自动判定，不做人工核实 —— 这是刻意设计，见第 3 页。', {
    x: 0.95, y: 6.62, w: 11, h: 0.32, fontFace: F, fontSize: 10, color: C.faint,
  })
}

// ---------------- P2 今日速览 ----------------
currentPage = 2
{
  const s = pptx.addSlide()
  paint(s, 'body')
  header(s, '今日速览', `${(brief.picks || []).length} 条要闻 · 一句话版`, 'list')

  let y = 1.42
  ;(brief.picks || []).forEach((p) => {
    const accent = p.topic === '具身智能' ? C.embodied : C.coding
    const dirIcon = p.topic === '具身智能' ? 'robot' : 'code'
    s.addShape(pptx.ShapeType.rect, { x: 0.6, y, w: 0.055, h: 0.78, fill: { color: accent } })
    solid(s, 'roundRect', 0.78, y, W - 1.58, 0.78, C.panel, { rectRadius: 0.04, line: { color: C.line, width: 0.75 } })

    s.addText(`${p.no}`, {
      x: 0.95, y: y + 0.08, w: 0.4, h: 0.62, fontFace: F, fontSize: 16, bold: true, color: accent, valign: 'middle',
    })
    icon(s, dirIcon, 1.42, y + 0.24, 0.28, accent)
    T(s, p.title, {
      x: 1.82, y: y + 0.08, w: W - 4.5, h: 0.62, fontFace: F, fontSize: 12, color: C.ink, valign: 'middle',
    })
    s.addShape(pptx.ShapeType.roundRect, {
      x: W - 2.55, y: y + 0.21, w: 0.72, h: 0.36, rectRadius: 0.18, fill: { color: LV[p.lv] || C.brand },
    })
    s.addText(`${p.lv}`, {
      x: W - 2.55, y: y + 0.21, w: 0.72, h: 0.36, fontFace: F, fontSize: 11, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
    })
    s.addText(`${p.topic}`, {
      x: W - 1.73, y: y + 0.08, w: 1.05, h: 0.62, fontFace: F, fontSize: 10, color: accent, valign: 'middle', align: 'right',
    })
    y += 0.9
  })

  // 底部统计条
  const lvCount = {}
  ;(brief.picks || []).forEach((p) => { lvCount[p.lv] = (lvCount[p.lv] || 0) + 1 })
  const topicCount = {}
  ;(brief.picks || []).forEach((p) => { topicCount[p.topic] = (topicCount[p.topic] || 0) + 1 })
  const lvStr = Object.entries(lvCount).map(([k, v]) => `${k}×${v}`).join(' · ')
  const topicStr = Object.entries(topicCount).map(([k, v]) => `${k} ${v} 条`).join(' ｜ ')
  const avgSrc = ((brief.picks || []).reduce((s2, p) => s2 + (p.sources || []).length, 0) / Math.max(1, (brief.picks || []).length)).toFixed(1)
  const barY = y + 0.08
  panel(s, 0.6, barY, W - 1.2, 0.56, { fill: C.panel2 })
  icon(s, 'shield', 0.85, barY + 0.16, 0.24, C.brand)
  T(s, `评级分布 ${lvStr} ｜ 平均来源 ${avgSrc} 个/条 ｜ ${topicStr}`, {
    x: 1.2, y: barY, w: W - 2.1, h: 0.56, fontFace: F, fontSize: 11, color: C.sub, valign: 'middle',
  })
  footer(s, 2)
}

// ---------------- P3 方法与置信度 ----------------
currentPage = 3
{
  const s = pptx.addSlide()
  paint(s, 'body')
  header(s, '方法', '置信度怎么定的（以及它不保证什么）', 'shield')

  let y = 1.38
  const lvIcon = { A: 'star', B: 'check', C: 'layers', D: 'warn' }
  ;(brief.confidenceScale || []).forEach((c) => {
    solid(s, 'roundRect', 0.6, y, 0.64, 0.64, LV[c.lv] || C.brand, { rectRadius: 0.1 })
    s.addText(c.lv, {
      x: 0.6, y, w: 0.64, h: 0.64, fontFace: F, fontSize: 17, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
    })
    icon(s, lvIcon[c.lv] || 'check', 1.4, y + 0.2, 0.24, LV[c.lv] || C.brand)
    s.addText(`${c.name}`, {
      x: 1.74, y: y + 0.02, w: 1.2, h: 0.3, fontFace: F, fontSize: 12, bold: true, color: C.ink, valign: 'middle',
    })
    T(s, c.rule, {
      x: 1.74, y: y + 0.3, w: W - 2.5, h: 0.32, fontFace: F, fontSize: 11, color: C.sub, valign: 'middle',
    })
    y += 0.8
  })

  const lowLv = (brief.picks || []).filter((p) => p.lv === 'C' || p.lv === 'D')
  const tail = lowLv.length === 1
    ? `本期第 ${lowLv[0].no} 条即据此定为 ${lowLv[0].lv}。`
    : lowLv.length > 1
      ? `本期第 ${lowLv.map((p) => p.no).join('、')} 条即据此定级偏低。`
      : ''
  panel(s, 0.6, y + 0.12, W - 1.2, 0.95, { fill: 'FFF7ED', line: 'FED7AA' })
  icon(s, 'warn', 0.86, y + 0.32, 0.3, 'B45309')
  T(s, '刻意区分「转载数量」与「独立信源数量」：多家媒体转述同一篇独家（如 TechCrunch 引述「两位知情人士」）不构成交叉验证，一律按单一信源降级。' + tail, {
    x: 1.32, y: y + 0.26, w: W - 2.3, h: 0.68, fontFace: F, fontSize: 11, color: '9A3412', valign: 'top',
  })
  footer(s, 3)
}

// ---------------- P4~P(3+n) 每条要闻一页 ----------------
let page = 4
for (const p of brief.picks || []) {
  currentPage = page
  const s = pptx.addSlide()
  const isEmbodied = p.topic === '具身智能'
  paint(s, isEmbodied ? 'embodied' : 'coding')
  const accent = isEmbodied ? C.embodied : C.coding
  const dirIcon = isEmbodied ? 'robot' : 'code'

  // 顶栏
  icon(s, dirIcon, 0.6, 0.34, 0.3, accent)
  s.addText(`要闻 ${p.no} / ${brief.picks.length}`, { x: 0.98, y: 0.34, w: 3, h: 0.3, fontFace: F, fontSize: 10, color: C.faint, valign: 'middle' })
  s.addShape(pptx.ShapeType.roundRect, { x: W - 2.95, y: 0.34, w: 0.8, h: 0.36, rectRadius: 0.18, fill: { color: LV[p.lv] || C.brand } })
  s.addText(`置信度 ${p.lv}`, {
    x: W - 2.95, y: 0.34, w: 0.8, h: 0.36, fontFace: F, fontSize: 10, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
  })
  s.addShape(pptx.ShapeType.roundRect, { x: W - 2.02, y: 0.34, w: 1.42, h: 0.36, rectRadius: 0.18, fill: { color: accent } })
  s.addText(p.topic, {
    x: W - 2.02, y: 0.34, w: 1.42, h: 0.36, fontFace: F, fontSize: 10, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
  })

  // 标题（最多两行）
  T(s, p.title, {
    x: 0.6, y: 0.78, w: W - 1.2, h: 0.9, fontFace: F, fontSize: 19, bold: true, color: C.ink, valign: 'top',
  })

  // 左：事件
  sectionLabel(s, 0.6, 1.8, 6.9, '事件', 'doc', C.brand)
  T(s, p.event || '', {
    x: 0.6, y: 2.06, w: 6.9, h: 1.5, fontFace: F, fontSize: 11, color: C.ink, valign: 'top', lineSpacingMultiple: 1.18,
  })

  // 左：关键事实
  // ⚠️ pptxgenjs 的 bullet 是段落属性且对多 run 段落不可靠：
  //    段首 run 带 bullet → 多 run 段落丢 bullet；所有 run 带 → 每个 run 独立成段。
  //    所以 keyFacts 必须用纯文本（一条一个对象），数字高亮只用于无 bullet 的 why 段。
  const facts = (p.keyFacts || []).map((f) => ({
    text: f,
    options: { bullet: { code: '25AA' }, breakLine: true },
  }))
  panel(s, 0.6, 3.66, 6.9, 2.28)
  sectionLabel(s, 0.82, 3.78, 5, '关键数字 / 事实', 'target', C.sub)
  Tbullets(s, facts, {
    x: 0.85, y: 4.06, w: 6.4, h: 1.78, fontFace: F, fontSize: 9.5, color: C.ink, valign: 'top', lineSpacingMultiple: 1.2,
  })

  // 右：为何值得关注
  s.addShape(pptx.ShapeType.rect, { x: 7.75, y: 1.8, w: 0.055, h: 4.14, fill: { color: accent } })
  sectionLabel(s, 8.0, 1.8, 4.7, '为什么值得关注', 'trend', accent)
  T(s, withNumRuns(p.why || '', C.ink, accent), {
    x: 8.0, y: 2.1, w: 4.73, h: 3.84, fontFace: F, fontSize: 11, valign: 'top', lineSpacingMultiple: 1.22,
  })

  // 底部来源
  // ⚠ 这一行**不要**留图标缩进：5 条来源名拼起来大约 12.1in 宽，
  //   本来就贴着 12.13in 的一行上限；前面加个 0.3in 的图标就会掉到第二行。
  //   实测过：加图标后 height 0.3 装不下（需要 0.41），溢出校验直接拦下了。
  //   所以这里给到 0.46 的两行余量，别指望它永远只有一行。
  const srcTxt = (p.sources || []).map((x) => x.name).join(' ｜ ')
  s.addShape(pptx.ShapeType.rect, { x: 0.6, y: 5.98, w: W - 1.2, h: 0.012, fill: { color: C.line } })
  T(s, `来源（${(p.sources || []).length}）：${srcTxt}`, {
    x: 0.6, y: 6.02, w: W - 1.2, h: 0.46, fontFace: F, fontSize: 9, color: C.sub, valign: 'top', lineSpacingMultiple: 1.2,
  })
  if (p.conflicts) {
    T(s, `差异与冲突：${p.conflicts}`, {
      x: 0.6, y: 6.52, w: W - 1.2, h: 0.34, fontFace: F, fontSize: 9, color: C.faint, valign: 'top',
    })
  }
  footer(s, page)
  page++
}

// ---------------- 扫读清单 ----------------
currentPage = page
{
  const s = pptx.addSlide()
  paint(s, 'body')
  header(s, '扫读清单', '今日其他值得瞄一眼的动态', 'list')

  const rows = (brief.alsoWorthAScan || []).map((a, i) => [
    { text: String(i + 1), options: { bold: true, color: C.brand } },
    { text: a.title },
    { text: a.sources || '', options: { color: C.sub, fontSize: 9 } },
  ])
  s.addTable(rows, {
    x: 0.6, y: 1.32, w: W - 1.2, colW: [0.45, 8.6, 3.08],
    fontFace: F, fontSize: 11, color: C.ink, valign: 'middle',
    border: { type: 'solid', color: C.line, pt: 0.5 },
    fill: { color: 'FFFFFF' },
    rowH: 0.6, autoPage: false,
  })
  s.addText('这些条目或信源不足、或与本期正条目主题重复、或已在上一轮推送过，因此只列不展开。', {
    x: 0.6, y: H - 1.12, w: W - 1.2, h: 0.3, fontFace: F, fontSize: 9, color: C.faint,
  })
  footer(s, page)
  page++
}

// ---------------- 数据分析（原生图表） ----------------
const charts = brief.charts
const hasCharts = !!charts
if (hasCharts) {
  currentPage = page
  const s = pptx.addSlide()
  paint(s, 'data')
  header(s, '数据分析', '这批数据长什么样', 'bars')

  // 左：置信度环形图
  sectionLabel(s, 0.6, 1.34, 4.0, '本期置信度分布', 'shield', C.sub)
  const conf = charts.confidence || { A: 0, B: 0, C: 0, D: 0 }
  const confTotal = Object.values(conf).reduce((a, b) => a + b, 0) || 1
  s.addChart(
    pptx.ChartType.doughnut,
    [{ name: '置信度', labels: ['A 极高', 'B 高', 'C 中', 'D 存疑'], values: ['A', 'B', 'C', 'D'].map((k) => conf[k] || 0) }],
    {
      ...chartBase,
      x: 0.5, y: 1.6, w: 4.2, h: 2.5,
      chartColors: ['1D4ED8', '0E7490', 'B45309', 'BE123C'],
      holeSize: 58,
      showLegend: true, legendPos: 'b', legendFontSize: 9, legendColor: C.sub,
      showValue: true, dataLabelColor: 'FFFFFF', dataLabelFontSize: 10, dataLabelFontFace: F,
      dataBorder: { pt: 1.5, color: 'FFFFFF' },
    }
  )
  // 左侧下方的关键数字
  panel(s, 0.6, 4.24, 4.0, 2.3)
  sectionLabel(s, 0.82, 4.36, 3.6, '语料规模', 'doc', C.sub)
  const corpus = charts.corpus || {}
  const rowsL = [
    ['原始条目', `${corpus.items ?? '—'} 条`, 'doc'],
    ['抓取窗口', `${corpus.from ?? '—'} → ${corpus.to ?? '—'}`, 'clock'],
    ['覆盖天数', `${corpus.spanDays ?? '—'} 天`, 'layers'],
  ]
  let ly = 4.68
  for (const [k, v, ic] of rowsL) {
    icon(s, ic, 0.85, ly + 0.02, 0.22, C.brand)
    s.addText(k, { x: 1.16, y: ly, w: 1.4, h: 0.26, fontFace: F, fontSize: 10, color: C.sub, valign: 'middle' })
    s.addText(v, { x: 2.55, y: ly, w: 1.9, h: 0.26, fontFace: F, fontSize: 10.5, bold: true, color: C.ink, align: 'right', valign: 'middle' })
    ly += 0.34
  }
  T(s, `单条最高提及占语料 ${Math.round((Math.max(0, ...(charts.models?.top || [{ count: 0 }]).map((m) => m.count)) / confTotal) * 100)}% —— 分布是长尾，不是少数几条刷屏。`, {
    x: 0.85, y: 5.78, w: 3.55, h: 0.6, fontFace: F, fontSize: 9, color: C.faint, valign: 'top', lineSpacingMultiple: 1.25,
  })

  // 右上：分类分布
  sectionLabel(s, 5.1, 1.34, 7.63, '抓取语料的分类分布（条）', 'layers', C.sub)
  const cat = (charts.category || []).slice(0, 6)
  s.addChart(
    pptx.ChartType.bar,
    [{ name: '条数', labels: cat.map((c) => c.name).reverse(), values: cat.map((c) => c.count).reverse() }],
    {
      ...chartBase,
      x: 5.0, y: 1.6, w: 7.73, h: 2.15,
      barDir: 'bar', barGapWidthPct: 45,
      chartColors: cat.map((_, i) => PALETTE[i % PALETTE.length]).reverse(),
      valAxisHidden: true,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 9, dataLabelColor: C.sub, dataLabelFontFace: F,
    }
  )

  // 右下：信源贡献
  sectionLabel(s, 5.1, 3.94, 7.63, '各信源贡献条数（Top 8）', 'network', C.sub)
  const src = (charts.sources || []).slice(0, 8)
  s.addChart(
    pptx.ChartType.bar,
    [{ name: '条数', labels: src.map((x) => x.label).reverse(), values: src.map((x) => x.count).reverse() }],
    {
      ...chartBase,
      x: 5.0, y: 4.2, w: 7.73, h: 2.35,
      barDir: 'bar', barGapWidthPct: 45,
      chartColors: ['4338CA'],
      valAxisHidden: true,
      showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 9, dataLabelColor: C.sub, dataLabelFontFace: F,
    }
  )
  footer(s, page)
  page++
}

// ---------------- 模型热度与趋势 ----------------
if (hasCharts && charts.models) {
  currentPage = page
  const s = pptx.addSlide()
  paint(s, 'trend')
  header(s, '模型热度与趋势', '抓取语料里，谁被提得最多、走势如何', 'trend')

  const top = (charts.models.top || []).slice(0, 8)
  const robots = (charts.models.topByKind?.robot || []).slice(0, 5)

  // 左上：主体提及 Top 8
  sectionLabel(s, 0.6, 1.32, 7.3, '主体提及热度（条）', 'bolt', C.sub)
  if (top.length) {
    s.addChart(
      pptx.ChartType.bar,
      [{ name: '提及', labels: top.map((m) => m.label).reverse(), values: top.map((m) => m.count).reverse() }],
      {
        ...chartBase,
        x: 0.5, y: 1.58, w: 7.43, h: 2.72,
        barDir: 'bar', barGapWidthPct: 40,
        chartColors: top.map((m) => (m.kind === 'agent' ? '0E7490' : m.kind === 'robot' ? '0F766E' : '4338CA')).reverse(),
        valAxisHidden: true,
        showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 9.5, dataLabelColor: C.sub, dataLabelFontFace: F,
      }
    )
  } else {
    T(s, '本期语料中没有命中模型关键词的条目。', { x: 0.6, y: 1.7, w: 7.3, h: 0.4, fontFace: F, fontSize: 11, color: C.sub })
  }

  // 右上：具身智能主体
  sectionLabel(s, 8.3, 1.32, 4.43, '具身智能主体', 'robot', C.embodied)
  if (robots.length) {
    s.addChart(
      pptx.ChartType.bar,
      [{ name: '提及', labels: robots.map((m) => m.label).reverse(), values: robots.map((m) => m.count).reverse() }],
      {
        ...chartBase,
        x: 8.2, y: 1.58, w: 4.53, h: 2.72,
        barDir: 'bar', barGapWidthPct: 40,
        chartColors: ['0F766E'],
        valAxisHidden: true,
        showValue: true, dataLabelPosition: 'outEnd', dataLabelFontSize: 9.5, dataLabelColor: C.sub, dataLabelFontFace: F,
      }
    )
  } else {
    panel(s, 8.2, 1.58, 4.53, 2.0, { fill: 'FFFFFF' })
    T(s, '本期语料里具身智能公司的提及都低于 3 次，不足以成图。这本身就是个信号：模型层的声量远高于本体层。', {
      x: 8.45, y: 1.82, w: 4.05, h: 1.55, fontFace: F, fontSize: 10.5, color: C.sub, valign: 'top', lineSpacingMultiple: 1.35,
    })
  }

  // 下：逐日趋势
  const tr = charts.models.trend || { days: [], series: [], dailyTotals: [] }
  sectionLabel(s, 0.6, 4.3, 12.13, `各主体逐日提及（最近 ${tr.windowDays || 0} 天，条）`, 'trend', C.sub)
  if (tr.series?.length && tr.days?.length) {
    s.addChart(
      pptx.ChartType.line,
      tr.series.map((se) => ({ name: se.label, labels: tr.days, values: se.values })),
      {
        ...chartBase,
        x: 0.5, y: 4.54, w: 12.33, h: 1.95,
        chartColors: TREND_COLORS,
        lineSize: 2, lineSmooth: false,
        lineDataSymbol: 'circle', lineDataSymbolSize: 5,
        showLegend: true, legendPos: 'b', legendFontSize: 9, legendColor: C.sub,
        valAxisMinVal: 0, catAxisLabelRotate: 0,
        valGridLine: { style: 'dash', color: 'E5E7EB', size: 0.5 },
      }
    )
  }
  T(s, md(`口径：只统计本期抓取语料里的提及次数，不是全网声量。窗口内逐日语料量：${(tr.dailyTotals || []).join(' / ')} 条 —— 越早的日期覆盖越不完整，所以趋势只看相对高低，不要当绝对热度读。`), {
    x: 0.6, y: 6.58, w: 12.13, h: 0.3, fontFace: F, fontSize: 8.5, color: C.faint, valign: 'top',
  })
  footer(s, page)
  page++
}

// ---------------- 数据与方法 ----------------
currentPage = page
{
  const s = pptx.addSlide()
  paint(s, 'body')
  header(s, '数据与方法', '这批数据是怎么来的', 'gear')

  const st = brief.rawStats || {}
  const cards = [
    { k: '原始条目', v: String(st.rawItems ?? '—'), u: '条', ic: 'doc' },
    { k: '存活信源', v: `${st.sourcesAlive ?? '—'}/${st.sourcesTotal ?? '—'}`, u: '个', ic: 'network' },
    { k: '多源共同报道', v: String(st.multiSourceItems ?? '—'), u: '条', ic: 'link' },
    { k: '精选要闻', v: String((brief.picks || []).length), u: '条', ic: 'target' },
  ]
  cards.forEach((c, i) => {
    const x = 0.6 + i * 3.1
    panel(s, x, 1.34, 2.9, 1.2)
    icon(s, c.ic, x + 0.22, 1.56, 0.28, C.brand)
    s.addText(c.k, { x: x + 0.6, y: 1.54, w: 2.1, h: 0.3, fontFace: F, fontSize: 10, color: C.sub, valign: 'middle' })
    s.addText(c.v, { x: x + 0.22, y: 1.86, w: 2.4, h: 0.52, fontFace: F, fontSize: 24, bold: true, color: C.ink })
    s.addText(c.u, { x: x + 2.15, y: 2.04, w: 0.5, h: 0.3, fontFace: F, fontSize: 10, color: C.faint })
  })

  const cat = st.byCategory || {}
  s.addText(`分类分布：AI Coding ${cat['AI Coding'] ?? 0} · 具身智能 ${cat['具身智能'] ?? 0} · 其他 ${cat['其他'] ?? 0} · AI 政策 ${cat['AI 政策'] ?? 0}`, {
    x: 0.6, y: 2.72, w: W - 1.2, h: 0.3, fontFace: F, fontSize: 11, color: C.ink,
  })

  // 方法说明区：阈值依据 / 查重说明 / 免责声明
  const methodRows = [
    { label: '多源关联阈值', text: md(st.note), ic: 'network' },
    { label: '查重说明', text: md(brief.dedupeNote), ic: 'list' },
    {
      label: '免责声明',
      text: '本 PPT 的结论未经人工逐条核实。置信度只反映「有多少个相互独立的信源在说同一件事」，不反映这件事本身是否为真。引用前请回到一手来源确认。',
      ic: 'warn',
    },
    ...(hasCharts
      ? [{ label: '图表口径', text: md(charts.corpus?.note), ic: 'bars' }]
      : []),
  ].filter((r) => r.text)

  const MFS = 10.5, MMULT = 1.25, MTW = 9.6, LBLW = 1.75, MLH = lineH(MFS, MMULT), MGAP = 0.16
  const laid = methodRows.map((r) => {
    const lines = Math.max(1, Math.ceil(textWidthIn(r.text, MFS) / MTW))
    return { ...r, h: lines * MLH }
  })
  const panelH = laid.reduce((a, r) => a + r.h, 0) + MGAP * (laid.length - 1) + 0.36
  const panelY = 3.2
  if (panelY + panelH > H - 1.2) {
    console.error(`[build-pptx] 数据与方法页说明区过高（${(panelY + panelH).toFixed(2)}in），请精简 rawStats.note / dedupeNote / charts.corpus.note。`)
    process.exit(1)
  }
  panel(s, 0.6, panelY, W - 1.2, panelH, { fill: C.panel2 })
  let ry = panelY + 0.18
  for (const r of laid) {
    icon(s, r.ic, 0.9, ry + 0.02, 0.2, C.faint)
    s.addText(r.label, {
      x: 1.18, y: ry, w: LBLW, h: r.h, fontFace: F, fontSize: 10, bold: true, color: C.sub, valign: 'top',
    })
    T(s, r.text, {
      x: 2.75, y: ry, w: MTW, h: r.h, fontFace: F, fontSize: MFS, color: C.ink, valign: 'top', lineSpacingMultiple: MMULT,
    })
    ry += r.h + MGAP
  }
  footer(s, page)
}

if (!hasCharts) {
  console.warn('[build-pptx] ⚠ brief.json 里没有 charts，已跳过「数据分析」与「模型热度与趋势」两页。')
  console.warn('            要出这两页请先跑：node scripts/analyze.mjs --date ' + date)
}

// ---------------- 溢出校验（写盘前，fail-fast） ----------------
const overflows = findOverflows()
if (overflows.length) {
  console.error(`[build-pptx] 溢出校验失败：${overflows.length} 处文本框装不下内容。不产出文件。`)
  overflows.forEach((o) => {
    console.error(`  P${o.page}  需要 ${o.needH} / 只有 ${o.h}  「${o.plain}…」`)
  })
  console.error('[build-pptx] 处理：精简 brief.json 对应字段（title/event/why/keyFacts），或调整版式。')
  process.exit(1)
}

// ---------------- 输出 ----------------
const outDir = OUT_DIR ? resolve(OUT_DIR) : join(KIT, '..', 'AI日报_' + date)
await mkdir(outDir, { recursive: true })
// 草稿单独命名：否则一次「立即生成草稿」会静默覆盖掉 Agent 已经产出的正式 PPTX，
// 而且覆盖后从文件名上完全看不出来。
const outFile = join(outDir, IS_DRAFT ? `AI日报_${date}_机器草稿.pptx` : `AI日报_${date}.pptx`)
// compression: true 让 pptxgenjs 用更高压缩级别打包 —— 背景图会重复写入多份
// （同一张图 addImage 几次就是几个 media 文件），压缩后体积差别明显。
await pptx.writeFile({ fileName: outFile, compression: true })
const pages = pptx.slides.length
const sizeKB = Math.round(statSync(outFile).size / 1024)
console.log(`[build-pptx] 已输出：${outFile}`)
console.log(`[build-pptx] 页数：${pages} · 大小：${sizeKB} KB · 溢出校验：通过（${registry.length} 个文本框）`)
console.log(`[build-pptx] 背景：${NO_BG ? '已关闭（--no-bg）' : `自研渐变 ${Object.keys(BGS).length} 个变体`} · 图标：${Object.keys(ICON_SET).length} 个 · 图表：${hasCharts ? '置信度 / 分类 / 信源 / 模型热度 / 趋势' : '无（缺 charts）'}`)
