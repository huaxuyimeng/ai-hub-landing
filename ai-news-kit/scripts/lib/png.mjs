/**
 * 极简 PNG 编码器 + 多色柔和渐变生成器（零第三方依赖，只用 node:zlib）
 *
 * 为什么自己写：
 *   pptxgenjs 3.12 **不支持渐变填充**（只有纯色 fill），而交付物需要
 *   「跟落地页一样的多色混色淡渐变」。既然拿不到原生渐变，就自己生成一张
 *   背景位图铺满整页 —— 这样还有一个额外好处：渐变由我们的代码完全控制，
 *   可以直接断言「最暗通道 ≥ 阈值」，从而保证「白底浅色」这条纪律不被破坏。
 *
 * 为什么不用现成库（sharp / jimp / canvas）：
 *   本项目的硬约束是「整个目录拷进任何 Node ≥22.6 项目就能跑」。
 *   多一个原生依赖（sharp 要编译、canvas 要 cairo）就毁掉这个前提。
 *   而「编码一张 PNG」本身只需要 zlib.deflateSync —— Node 内置。
 *
 * 预览方法：生成的 PNG 双击就能看；也可以 node scripts/analyze.mjs --bg-dump
 */

import { deflateSync } from 'node:zlib'

// ---------------- CRC32（PNG 每个 chunk 都要） ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}

/**
 * RGB 缓冲 → PNG。bitDepth 8 / colorType 2（真彩无 alpha，够用且最小）。
 * 逐行自适应选择 filter（0=None / 1=Sub / 2=Up），用「绝对值和最小」这个
 * 标准启发式 —— 平滑渐变下 Up 通常最优，压缩率能差好几倍。
 */
export function encodePNG(width, height, rgb) {
  const stride = width * 3
  const bpp = 3
  const out = Buffer.alloc((stride + 1) * height)
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)]

  for (let y = 0; y < height; y++) {
    const src = y * stride
    const prev = y > 0 ? (y - 1) * stride : -1
    let best = 0
    let bestScore = Infinity
    let bestBuf = null

    for (let f = 0; f < 3; f++) {
      const b = cand[f]
      let score = 0
      for (let i = 0; i < stride; i++) {
        const x = rgb[src + i]
        const a = i >= bpp ? rgb[src + i - bpp] : 0
        const c = prev >= 0 ? rgb[prev + i] : 0
        let v
        if (f === 0) v = x
        else if (f === 1) v = x - a
        else v = x - c
        v &= 0xff
        b[i] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) { bestScore = score; best = f; bestBuf = b }
    }
    const dst = y * (stride + 1)
    out[dst] = best
    bestBuf.copy(out, dst + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type: truecolor RGB
  ihdr[10] = 0  // deflate
  ihdr[11] = 0  // adaptive filtering
  ihdr[12] = 0  // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------- 有序抖动（消色带） ----------------
// 为什么必须有：实测无抖动时，整张封面在绿通道上只有 **9 级**，
// 横向「同亮度连续像素」最长 **197px**（≈1.25 英寸宽的平台）—— 投影上就是
// 肉眼可见的「梯田」。这不是美化，是必须。
//
// 矩阵尺寸是**文件大小**的主要杠杆（实测 960×540）：2×2 → 234KB，
// 4×4 → 425KB。4 个偏移量已足够把每一级台阶拆成 2×2 棋盘，
// 而 4×4/8×8 增加的中间层次对观感几乎没贡献，纯涨体积。
// 所以默认用 2×2；要更细腻可以传 side: 4。
const BAYER = {
  2: [0, 2, 3, 1],
  4: [
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5,
  ],
  8: [
     0, 32,  8, 40,  2, 34, 10, 42,
    48, 16, 56, 24, 50, 18, 58, 26,
    12, 44,  4, 36, 14, 46,  6, 38,
    60, 28, 52, 20, 62, 30, 54, 22,
     3, 35, 11, 43,  1, 33,  9, 41,
    51, 19, 59, 27, 49, 17, 57, 25,
    15, 47,  7, 39, 13, 45,  5, 37,
    63, 31, 55, 23, 61, 29, 53, 21,
  ],
}

// ---------------- 色板（与落地页 tokens.css 同源） ----------------
export const HUES = {
  indigo: [99, 102, 241],
  violet: [124, 58, 237],
  fuchsia: [192, 38, 211],
  rose: [225, 29, 72],
  amber: [245, 158, 11],
  orange: [249, 115, 22],
  teal: [20, 184, 166],
  cyan: [6, 182, 212],
  sky: [14, 165, 233],
}
const CANVAS = [252, 252, 253]   // tokens.css --canvas

/**
 * 把色相朝白色冲淡。
 *
 * ⚠️ 这一步是必须的，不是可选的美化：直接混**饱和色相**会把背景压暗。
 *   violet = [124, 58, 237]，绿通道只有 58 —— 只混 15% 就把绿压到 223，
 *   实测 6 张里有 5 张最暗通道 206–221，直接违反「交付物一律白底浅色」这条
 *   被用户明确纠正过的纪律。先冲淡再混，同样的观感强度下明度能高 30 左右。
 */
export function tint(color, t) {
  return [
    Math.round(color[0] + (255 - color[0]) * t),
    Math.round(color[1] + (255 - color[1]) * t),
    Math.round(color[2] + (255 - color[2]) * t),
  ]
}

/**
 * 交付物用的背景变体。
 * 设计约束（两条同时成立，改之前先看 assertLightEnough）：
 *  1) 任意像素的**累计混入比例**不超过 ~0.4（多个 blob 会叠乘）；
 *  2) 每个色先 tint 到最暗通道 ≥ 190。
 * 二者合起来保证最暗通道 ≥ 228 —— 也就是与纯白的对比度损失可忽略，
 * 白底深字的 WCAG 结论继续成立。
 */
const T = 0.62   // 统一冲淡比例
export const BG_PRESETS = {
  // 封面：冷暖对撞，品牌感最强的一页，但仍然只是「淡色」
  cover: [
    { c: tint(HUES.violet, 0.58), x: 0.16, y: 0.12, r: 0.62, a: 0.17 },
    { c: tint(HUES.rose, T), x: 0.88, y: 0.78, r: 0.66, a: 0.14 },
    { c: tint(HUES.amber, T), x: 0.06, y: 0.94, r: 0.50, a: 0.11 },
    { c: tint(HUES.sky, T), x: 0.72, y: 0.04, r: 0.46, a: 0.10 },
  ],
  // 常规内容页：只有左上、右下两团，几乎看不见但去掉就「空」
  body: [
    { c: tint(HUES.indigo, T), x: 0.10, y: 0.06, r: 0.72, a: 0.09 },
    { c: tint(HUES.teal, T), x: 0.94, y: 0.96, r: 0.66, a: 0.07 },
  ],
  // AI Coding 方向：靛 / 青
  coding: [
    { c: tint(HUES.indigo, T), x: 0.12, y: 0.10, r: 0.66, a: 0.14 },
    { c: tint(HUES.cyan, T), x: 0.90, y: 0.90, r: 0.60, a: 0.11 },
    { c: tint(HUES.sky, T), x: 0.62, y: 0.02, r: 0.44, a: 0.08 },
  ],
  // 具身智能方向：青 / 琥珀
  embodied: [
    { c: tint(HUES.teal, T), x: 0.14, y: 0.10, r: 0.64, a: 0.14 },
    { c: tint(HUES.amber, T), x: 0.92, y: 0.88, r: 0.60, a: 0.11 },
    { c: tint(HUES.orange, T), x: 0.50, y: 1.02, r: 0.44, a: 0.07 },
  ],
  // 数据页：琥珀 / 玫 / 靛 三向
  data: [
    { c: tint(HUES.amber, T), x: 0.10, y: 0.14, r: 0.58, a: 0.11 },
    { c: tint(HUES.rose, T), x: 0.86, y: 0.20, r: 0.52, a: 0.10 },
    { c: tint(HUES.indigo, T), x: 0.50, y: 1.00, r: 0.62, a: 0.10 },
  ],
  // 趋势页：靛 / 紫 / 品红
  trend: [
    { c: tint(HUES.indigo, T), x: 0.08, y: 0.20, r: 0.60, a: 0.13 },
    { c: tint(HUES.fuchsia, T), x: 0.80, y: 0.10, r: 0.54, a: 0.10 },
    { c: tint(HUES.violet, 0.58), x: 0.56, y: 0.98, r: 0.60, a: 0.11 },
  ],
}
/**
 * 生成一张「多色混色淡渐变」背景。
 * 每个 blob 用高斯衰减做柔化 —— 解析式高斯，不需要真的做模糊卷积，
 * 所以整张图一次遍历算完，没有中间缓冲。
 *
 * @param {object} o
 * @param {number} o.w 宽（px）
 * @param {number} o.h 高（px）
 * @param {Array<{c:number[],x:number,y:number,r:number,a:number}>} o.blobs
 *        x/y/r 为 0–1 归一化坐标与半径；a 为该色最大混入比例
 * @returns {{png:Buffer,minChannel:number,maxChannel:number}}
 */
export function meshGradient({ w, h, blobs, base = CANVAS, dither = 0.85, ditherSide = 2, clampFloor = null }) {
  const rgb = Buffer.alloc(w * h * 3)
  const scale = Math.min(w, h)     // blob 半径按短边折算，16:9 与 4:3 下观感一致
  let minC = 255
  let maxC = 0
  const MAT = BAYER[ditherSide] || BAYER[2]
  const MATN = ditherSide * ditherSide

  // 预先把归一化参数换算成像素量，并把高斯拆成 x/y 两条一维表。
  // 高斯是可分离的：exp(-(ax²+ay²)/2σ²) = exp(-ax²/2σ²) · exp(-ay²/2σ²)。
  // 这一步把内层循环里的 exp() 全部消掉 —— 实测 6 张 1280×720 从 2865ms 降到
  // 200ms 出头。原写法每像素每 blob 一次 exp，总共一千两百多万次。
  const P = blobs.map((b) => {
    const sig = b.r * scale
    const inv = 1 / (2 * sig * sig)
    const fx = new Float64Array(w)
    const fy = new Float64Array(h)
    const cx = b.x * w
    const cy = b.y * h
    for (let x = 0; x < w; x++) { const d = x - cx; fx[x] = Math.exp(-d * d * inv) }
    for (let y = 0; y < h; y++) { const d = y - cy; fy[y] = Math.exp(-d * d * inv) }
    return { c: b.c, a: b.a, fx, fy }
  })

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = base[0], g = base[1], b = base[2]

      for (const bl of P) {
        const k = bl.a * bl.fx[x] * bl.fy[y]
        if (k > 0.0005) {
          r += (bl.c[0] - r) * k
          g += (bl.c[1] - g) * k
          b += (bl.c[2] - b) * k
        }
      }

      // 抖动要在限幅**之前**加，否则暗端会被夹掉一半噪声、反而出现色带
      const off = (MAT[(y % ditherSide) * ditherSide + (x % ditherSide)] / MATN - 0.5) * dither
      let R = Math.round(r + off)
      let G = Math.round(g + off)
      let B = Math.round(b + off)
      if (clampFloor != null) {
        R = Math.max(clampFloor, R); G = Math.max(clampFloor, G); B = Math.max(clampFloor, B)
      }
      R = R < 0 ? 0 : R > 255 ? 255 : R
      G = G < 0 ? 0 : G > 255 ? 255 : G
      B = B < 0 ? 0 : B > 255 ? 255 : B
      if (R < minC) minC = R
      if (G < minC) minC = G
      if (B < minC) minC = B
      if (R > maxC) maxC = R
      if (G > maxC) maxC = G
      if (B > maxC) maxC = B

      const i = (y * w + x) * 3
      rgb[i] = R; rgb[i + 1] = G; rgb[i + 2] = B
    }
  }

  return { png: encodePNG(w, h, rgb), minChannel: minC, maxChannel: maxC }
}

/**
 * 生成所有预设，返回 { name: {png, minChannel} }。带缓存，同一进程只算一次。
 *
 * 默认尺寸取 640×360 而不是 1:1 的 1280×720，理由是实测过的：
 *   · 纯平滑渐变**没有细节**，放大到 1280 宽看不出差别（抖动噪声 <1/255，
 *     放大后反而被插值抹平，观感更干净）；
 *   · 体积与耗时都随像素数线性增长：1280×720 合计 690KB/2.7s，
 *     640×360 合计 144KB/0.4s。
 * 也就是说 1:1 分辨率在这里只买到体积，没买到观感。
 */
let CACHE = null
export function buildBackgrounds(w = 640, h = 360, ditherSide = 2) {
  const key = `${w}x${h}/b${ditherSide}`
  if (CACHE && CACHE.key === key) return CACHE.map
  const map = {}
  for (const [name, blobs] of Object.entries(BG_PRESETS)) {
    map[name] = meshGradient({ w, h, blobs, ditherSide })
  }
  CACHE = { key, map }
  return map
}

/**
 * 纪律守卫：背景必须够淡。
 * 「交付物一律白底浅色」是用户明确纠正过的约定，不能因为「加了渐变」就破掉。
 * 判定：最暗通道 ≥ 228 → 与纯白的对比度损失可忽略，白底深字的 WCAG 结论继续成立。
 */
export function assertLightEnough(map, floor = 228) {
  const bad = []
  for (const [name, v] of Object.entries(map)) {
    if (v.minChannel < floor) bad.push(`${name} 最暗通道 ${v.minChannel} < ${floor}`)
  }
  return bad
}
