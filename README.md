# AIHub · 公开落地站

> 公开演示站：GitHub Pages + Vercel Functions
> 在线访问：[https://huaxuyimeng.github.io/ai-hub-landing/](https://huaxuyimeng.github.io/ai-hub-landing/)

---

## 目录

- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [本地开发](#本地开发)
- [部署到 Vercel](#部署到-vercel)
- [故障排查](#故障排查)

---

## 快速开始

### 公网演示

打开 [https://huaxuyimeng.github.io/ai-hub-landing/](https://huaxuyimeng.github.io/ai-hub-landing/) 即可浏览。

点击「每日早报」→ 点「立即生成今日早报」→ 首次需要输入 DeepSeek API Key（默认模型 deepseek-chat）。

### 本地预览

```bash
cd ai-hub-landing
# 预览静态页面
npx serve . -p 8080
# 另起终端，跑生成服务（可选，不跑则只能看页面 UI）
node ai-news-kit/scripts/serve.mjs
# 打开 http://localhost:8080/briefing.html
```

---

## 项目结构

```
ai-hub-landing/
├── index.html / briefing.html / ...    落地页（纯静态，GitHub Pages 托管）
├── assets/                              CSS / JS / 图片
├── api/                                Vercel Functions（公网生成服务）
│   ├── _lib/kit.js                    共享任务执行器
│   ├── health.js / history.js          状态查询
│   ├── generate.js                    触发生成
│   ├── jobs/[id].js                   轮询任务状态
│   ├── brief.js                       读取选稿
│   └── download.js                    下载 PPTX / Markdown
├── ai-news-kit/                        新闻采集 + 选稿 + 渲染流水线
│   ├── scripts/
│   │   ├── aggregate.mjs              10 源抓取
│   │   ├── draft-brief.mjs           机器草稿选稿
│   │   ├── agent-pick.mjs             DeepSeek Agent 选稿
│   │   ├── build-pptx.mjs            渲染 PPTX
│   │   └── brief-to-md.mjs            生成 Markdown
│   └── data/                          数据归档（gitignore）
├── vercel.json                         Vercel 函数配置
└── .gitignore
```

---

## 本地开发

### 生成服务（可选）

```bash
# 默认 127.0.0.1:8787
node ai-news-kit/scripts/serve.mjs

# 自定义端口
node ai-news-kit/scripts/serve.mjs --port 9000
```

### 单独跑某一步

```bash
# 抓取今天
node ai-news-kit/scripts/aggregate.mjs --date 2026-09-19

# 机器草稿选稿
node ai-news-kit/scripts/draft-brief.mjs --date 2026-09-19

# Agent 选稿（需要 DeepSeek Key）
DEEPSEEK_API_KEY=sk-... node ai-news-kit/scripts/agent-pick.mjs --date 2026-09-19

# 渲染 PPTX
node ai-news-kit/scripts/build-pptx.mjs --date 2026-09-19
```

### 全链路 dry-run

```bash
node tests/dry-run.mjs   # 需要先设 AIHUB_DATA_DIR 环境变量
```

---

## 部署到 Vercel

### 1. 新建 Vercel 项目

1. 打开 [https://vercel.com/new](https://vercel.com/new)
2. Import `huaxuyimeng/ai-hub-landing`
3. **Framework Preset**：选 `Other`
4. **Root Directory**：留空
5. 点 Deploy

### 2. 配置环境变量

进 Project Settings → Environment Variables：

| Key | Value |
|---|---|
| `DEEPSEEK_API_KEY` | 你的 DeepSeek API Key（可选项，不填则只走机器草稿） |
| `AIHUB_KIT_MODE` | `production` |

> DeepSeek API Key 只影响「选稿」环节。不填也能生成 PPT（走机器草稿链路）。

### 3. 验证

部署完成后，打开：
```
https://<你的-vercel-项目>.vercel.app/api/health
```
应返回 `{ ok: true, version: "...", today: "2026-09-19" }`

---

## 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| GitHub Pages 404 | 还没部署完成 | 等 2 分钟再试 |
| 「生成服务没连上」 | Vercel 项目还没建 | 完成 Vercel 部署即可 |
| Vercel /api/health 返回 404 | Vercel 项目还没建或函数超时 | 检查 Vercel Dashboard → Functions 日志 |
| PPT 一直显示「机器草稿」 | DeepSeek Key 未填或 API 失败 | 检查 Vercel 日志；填入 `DEEPSEEK_API_KEY` 环境变量 |
| 本地 `serve.mjs` 连不上 | 系统代理（如 Clash）把 127.0.0.1 加进了代理列表 | 把 `127.0.0.1` 加进代理的「绕过列表」 |

---

## 架构说明

- **GitHub Pages**：纯静态站点（8 个 HTML + CSS/JS/图片）
- **Vercel Functions**：生成服务（抓取 → 选稿 → 渲染 → 打包）
- **DeepSeek API**：Agent 选稿（可选）
- **存储**：Vercel Function `/tmp`（冷启动后数据清空；产物可重算，约 30s）

---

## 许可证

MIT
