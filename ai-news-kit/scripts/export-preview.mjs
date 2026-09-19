#!/usr/bin/env node
/**
 * pptx → PNG 预览导出（Windows，走 PowerPoint COM）
 *
 * 用途：渲染后做视觉验证。肉眼确认无重叠 / 无裁剪 / 配色正确，
 *       比「渲染 exit 0 就当成功」可靠得多。
 *
 * 用法：
 *   node scripts/export-preview.mjs --file D:/path/AI日报.pptx [--out D:/path/preview]
 *
 * 依赖：Windows + 已安装 PowerPoint。失败只降级（exit 0），不阻断流水线。
 *
 * ⚠️ 已知限制：直接双击/终端运行本脚本可能报「HRESULT E_FAIL」（PowerPoint COM
 *    对启动环境敏感，-STA 亦未解决）。此时改用等价 PowerShell 片段手动导出
 *    （见 docs/06-踩坑记录.md「pptx→PNG 预览」一节），视觉验证流程不变。
 *
 * ⚠️ 实现注意（都踩过坑）：
 *   1) 临时 ps1 必须写到 os.tmpdir()——写进输出目录会被脚本第一步的
 *      Remove-Item 连自己一起删掉，表现为静默失败。
 *   2) 结果判断走日志文件，不依赖 PowerShell stdout（本机 stdout 会被吞）。
 *   3) 渲染进程要完全退出后再打开 pptx，否则 COM 打不开文件。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const args = process.argv.slice(2)
const getArg = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}

const FILE = getArg('--file', null)
const OUT = getArg('--out', null)

if (!FILE || !existsSync(FILE)) {
  console.error(`usage: node scripts/export-preview.mjs --file <pptx> [--out DIR]\n  文件不存在：${FILE}`)
  process.exit(2)
}
const file = resolve(FILE)
const out = resolve(OUT || join(dirname(file), 'preview'))

if (process.platform !== 'win32') {
  console.log('[export-preview] 非 Windows，跳过预览导出（不影响产物）。')
  process.exit(0)
}

const logFile = join(tmpdir(), 'ai-news-kit-export.log')
const psFile = join(tmpdir(), 'ai-news-kit-export.ps1')
const p = (s) => s.replace(/\\/g, '\\')

writeFileSync(psFile, `
$log = '${p(logFile)}'
$src = '${p(file)}'
$outDir = '${p(out)}'
Set-Content -Path $log -Value 'begin' -Encoding UTF8
if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $pres = $null
  # 文件可能刚写完、句柄未释放，重试 3 次
  for ($i = 1; $i -le 3; $i++) {
    try { $pres = $app.Presentations.Open($src, $true, $false, $false); break }
    catch { Add-Content $log ("open_retry_" + $i); Start-Sleep -Seconds 2 }
  }
  if ($pres -eq $null) { throw "open failed after 3 retries" }
  $pres.Export($outDir, "PNG", 1600, 900)
  $pres.Close(); $app.Quit()
  Add-Content $log "EXPORT_OK"
} catch {
  Add-Content $log ("EXPORT_FAIL: " + $_.Exception.Message)
}
`, 'utf8')

// 给渲染进程释放文件句柄留一点时间
setTimeout(() => {
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', psFile], { stdio: 'ignore' })
  child.on('exit', () => {
    const content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : 'NO_LOG'
    if (content.includes('EXPORT_OK')) {
      const n = readdirSync(out).filter((f) => f.toLowerCase().endsWith('.png')).length
      console.log(`[export-preview] 已导出 ${n} 张预览图 → ${out}`)
    } else {
      console.warn(`[export-preview] 导出失败（不阻断）：${content.trim()}`)
    }
    rmSync(psFile, { force: true })
    process.exit(0)
  })
  child.on('error', (e) => {
    console.warn(`[export-preview] PowerShell 调用失败（不阻断）：${e.message}`)
    process.exit(0)
  })
}, 800)
