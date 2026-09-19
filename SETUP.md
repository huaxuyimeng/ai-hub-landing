# 部署操作手册

> 本手册假设你在 **2026-09-19** 完成本地开发，准备推到 GitHub + Vercel。
> 全程预计 15 分钟，包括 Vercel 冷启动等待。

---

## 第 1 步：GitHub 建仓库（你做，2 分钟）

打开 https://github.com/new ：

| 字段 | 值 |
|---|---|
| Owner | `huaxuyimeng` |
| Repository name | `ai-hub-landing` |
| Description | `AIHub 公开演示站 · 静态页面 + Vercel 生成服务` |
| Public/Private | **Public** |
| Initialize | **不要勾**任何选项 |

点 "Create repository"，记下 SSH URL（大概是 `git@github.com:huaxuyimeng/ai-hub-landing.git`）。

---

## 第 2 步：本地初始化 + 推送（你做，2 分钟）

```bash
cd D:\1Money\aihub\ai-hub-landing
git init
git add .
git commit -m "feat: initial landing site + ai-news-kit + Vercel API"
git remote add origin git@github.com:huaxuyimeng/ai-hub-landing.git
git branch -M main
git push -u origin main
```

---

## 第 3 步：开启 GitHub Pages（你做，1 分钟）

1. 进 https://github.com/huaxuyimeng/ai-hub-landing/settings/pages
2. **Source**：`Deploy from a branch`
3. **Branch**：`main` / `(root)` → Save
4. 等待 30 秒 ~ 2 分钟，会显示：
   > Your site is live at `https://huaxuyimeng.github.io/ai-hub-landing/`

**验证**：打开这个链接，首页应该正常渲染。点 `briefing.html`，「立即生成」按钮会显示「生成服务没连上」——因为 Vercel 后端还没建，这是预期。

---

## 第 4 步：建 Vercel 项目（你做，5 分钟）

1. 打开 https://vercel.com/new
2. 选 "Import Git Repository" → 找到 `huaxuyimeng/ai-hub-landing` → Import
3. **Project Name**：`ai-hub-landing`（这决定你的域名是 `ai-hub-landing.vercel.app`）
4. **Framework Preset**：选 `Other`
5. **Root Directory**：留空
6. **Build & Output Settings**：都不填（纯静态站无需 build）

进到 Environment Variables 步骤，添加：

| Key | Value | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | `<你的 DeepSeek Key，从 https://platform.deepseek.com 获取>` | 可选，不填只走机器草稿 |
| `AIHUB_KIT_MODE` | `production` | 必填，标记生产环境 |

> **DeepSeek API Key 是可选的**：不填也能生成 PPT，但只能走机器草稿链路（不经 DeepSeek 选稿，质量较低）。填入后首次点击「立即生成」时需要输入 Key（界面有弹窗引导）。

然后点 Deploy，等待 ~1 分钟。

---

## 第 5 步：验证 Vercel 后端（你做，1 分钟）

部署完成后，浏览器打开：

```
https://ai-hub-landing.vercel.app/api/health
```

**预期**（第二批完成后）：
```json
{ "ok": true, "version": "0.6.1", "today": "2026-09-19", "todayState": { "hasBrief": false, "hasNews": false } }
```

如果看到 Vercel 404 页面 → 等待部署完成后再试。

---

## 第 6 步：端到端验证（你做，2 分钟）

1. 打开 `https://huaxuyimeng.github.io/ai-hub-landing/briefing.html`
2. 点「立即生成今日早报」
   - 第一次：弹出 API Key 输入框（默认 deepseek-chat）→ 填入 Key 或点「只用机器草稿」
   - 之后：正常流程，真实抓取 + 渲染
3. 等待 10-30 秒，看到四步进度条完成
4. 点「下载 PPTX」，下载文件并验证

---

## 第 7 步：自定义域名（可选）

### 让 GitHub Pages 用自己的域名

1. 域名 DNS 加一条 CNAME：`aihub.yourdomain.com` → `huaxuyimeng.github.io`
2. 仓库根目录加 `CNAME` 文件，内容写 `aihub.yourdomain.com`
3. GitHub Pages 设置 Custom domain 填 `aihub.yourdomain.com`

### 让 Vercel 用自己的域名

参考 https://vercel.com/docs/concepts/projects/domains ，加一条 CNAME `gen.yourdomain.com` → `cname.vercel-dns.com`

---

## 排错速查

| 现象 | 原因 | 解决 |
|---|---|---|
| `git push` 报权限错 | SSH key 没配 | `ssh-add ~/.ssh/id_ed25519` 或换 HTTPS URL + PAT |
| Vercel 部署失败 | 查看 Functions 日志 | Vercel Dashboard → Functions → 查看 error 列 |
| PPT 生成 502 | DeepSeek API key 错误或超时 | 检查 env var；Vercel Runtime Logs 看报错 |
| PPT 是「机器草稿」| DeepSeek Key 未填 / API 超时 | 正常降级；填 Key 后重新生成 |
| 本地 `serve.mjs` 连不上 | 系统代理挡住 127.0.0.1 | 把 `127.0.0.1` 加进代理的绕过列表 |

---

**最后一步**：把 GitHub 链接和 Vercel 域名告诉我，我做最后的端到端验证。
