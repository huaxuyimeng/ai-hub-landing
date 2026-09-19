# ai-news-kit · 每日 AI 新闻 + PPT 流水线

把「今天的 AI 新闻 → 一份可信的日报 + 一份 PPT」跑成一条**可复现、可移植、可审计**的流程。
整个目录可以原样拷进任意 Node ≥22.6 项目。

---

## 一分钟理解它在干什么

```
① 机器做（aggregate.mjs）     ② 我做（判断层）          ③ 机器做（统计 + 渲染）
抓 10 源 → 归一化 → 去重        外部核验 → 查重 → 选题        analyze：纯统计出图表数据
→ 多源关联 → 分类 → 归档        → 定级 → 写「为什么值得关注」  build：渐变底 + 图标 + 图表
       ↓                                ↓                            ↓
   news.json                       brief.json                   .pptx + .md
 （机器产物，可重跑）     （★唯一真相源：选稿 + charts）    （纯渲染，不含判断与计算）
```

**核心原则：`brief.json` 是唯一真相源。渲染脚本只渲染，不做任何判断。**

② 这一段是「判断」，只有 Agent（或人）能做。所以整条链路有两个入口：
**定时**（每天 07:00，负责不漏）与**手动**（`npm run serve` 或页面按钮，负责现在就要）。
手动触发时如果 ② 还没有产物，会自动降级成**机器草稿**并明确标注，绝不假装有判断。

---

## 快速开始

```bash
cd ai-news-kit
npm install                                    # 只装 pptxgenjs

node scripts/aggregate.mjs                     # ① 抓取 → data/YYYY-MM-DD/news.json
cp templates/brief.template.json data/2026-09-14/brief.json
#  ② 编辑 brief.json（选稿 + 定级 + 写 why）—— 见 docs/02

node scripts/validate-brief.mjs --date 2026-09-14                          # ③ 校验（业务规则）
node scripts/analyze.mjs --date 2026-09-14                        # ③b 统计图表数据 → 写回 brief.charts
node scripts/build-pptx.mjs --date 2026-09-14 --out ../AI日报_2026-09-14   # ④ PPT
node scripts/brief-to-md.mjs --date 2026-09-14 --out ../AI新闻推送_2026-09-14.md

npm test                                       # 改过渲染脚本后跑一次（11 项断言）
```

不想敲命令、想「点一下就要一份」：

```bash
npm run serve                                  # http://127.0.0.1:8787（只监听本机）
# 浏览器打开自检页，或在落地页 briefing.html 的「手动生成」控制台点按钮
node scripts/serve.mjs --selftest              # 不起服务，跑一次完整链路并打印结果
```

没有 Agent 选稿时会自动降级成**机器草稿**：单独文件名 + 封面徽标 + 每页页脚标记，
置信度上限 B —— 详见 [09-手动触发生成服务.md](./docs/09-手动触发生成服务.md)。

---

## 文档导航

### 想理解「为什么这么设计」

| 文档 | 内容 |
|---|---|
| **[00-设计思路.md](./docs/00-设计思路.md)** | ★ 核心。为什么不卷排版、护城河在哪、三段分工的动机、放弃了什么、还没解决什么 |
| [01-架构与数据流.md](./docs/01-架构与数据流.md) | 目录结构、数据流全景、两个产物的区别、为什么渲染不做兜底 |
| [07-演进路线.md](./docs/07-演进路线.md) | 知道有问题但还没做的事，按性价比排序 |

### 想跑起来

| 文档 | 内容 |
|---|---|
| **[10-我是如何工作的.md](./docs/10-我是如何工作的.md)** | ★★ Agent 作业方法全公开：七步动作、三个判断点、三道 fail-fast 闸、怎么插进别的项目 |
| **[02-每日作业手册.md](./docs/02-每日作业手册.md)** | ★ 7 步 SOP、降级处理、不可违反的纪律 |
| **[03-置信度评级规则.md](./docs/03-置信度评级规则.md)** | ★ A/B/C/D 硬规则、转载不算独立信源、为什么偏低是安全的 |
| **[09-手动触发生成服务.md](./docs/09-手动触发生成服务.md)** | ★ 一键触发生成：接口契约、agent/draft 两种模式、怎么接前端、安全边界与排错 |
| [04-数据契约.md](./docs/04-数据契约.md) | `brief.json` / `news.json` 每个字段的要求与正反例 |
| [06-踩坑记录.md](./docs/06-踩坑记录.md) | 23 个真实踩过的坑（新增：负 cx/cy、图片不去重、抖动与色带、COM 导出其实可用）（含 ESM 不认 NODE_PATH、时区、并行改文件丢失、中文文件名响应头） |

### 想接进别的项目

| 文档 | 内容 |
|---|---|
| [05-接入其他项目.md](./docs/05-接入其他项目.md) | 全量接入 3 步、只要数据不要 PPT、只要规范不要代码 |
| [数据源实测.md](./docs/数据源实测.md) | 10 个源的实测条数、6 个已失效源、加新源检查清单 |

### 想看一次真实作业

| 文档 | 内容 |
|---|---|
| [08-实战复盘-2026-09-14.md](./docs/08-实战复盘-2026-09-14.md) | 第一次完整跑通的全过程，含 3 个关键判断点 |

---

## 和旧版 `ai-news-daily` 的区别

| | 旧版 | 本工具包 |
|---|---|---|
| 形态 | DSH 插件（bundle-client） | 纯 Node 脚本，任意项目可跑 |
| 渲染 | slidep（**内部包**，外人跑不起来）+ pptxgenjs 双产线 | 只用 pptxgenjs（公开包） |
| 唯一真相源 | 无，选稿逻辑散在脚本里 | `data/YYYY-MM-DD/brief.json` |
| 外部核验 | 无，完全依赖 `relatedSources` 计数 | 强制 WebSearch 找一手来源 |
| 转载 vs 独立源 | 混为一谈 | 显式区分，直接影响评级 |
| 复用性 | 绑死 DSH 目录结构 | 整个目录可拷走，路径全相对 |
| 探针脚本 | 6 个 `__probe-*.mjs` 遗留 | 不迁移 |

**抓取 / 去重 / 时间解析的核心代码一行没改** —— 已验证过的逻辑不要重写。

---

## 目录结构

```
ai-news-kit/
├── README.md                 本文件（导航）
├── SKILL.md                  Agent 作业规范（可被技能系统加载）
├── CHANGELOG.md
├── package.json              唯一依赖：pptxgenjs
├── docs/                     11 份设计 & 作业文档（见上）
├── scripts/
│   ├── aggregate.mjs         ① 抓取（零第三方依赖）
│   ├── date-util.mjs           本地时区日期
│   ├── storage.mjs             原子写盘 + 日期归档
│   ├── time-utils.mjs          发布时间解析
│   ├── draft-brief.mjs       ② 机器草稿选稿（无 Agent 时的降级，draft:true）
│   ├── validate-brief.mjs    ③ 结构 + 业务规则校验（零新依赖）
│   ├── analyze.mjs           ③b 纯统计 → 把 charts 写回 brief.json
│   └── lib/png.mjs             自研 PNG 编码器 + 多色渐变生成器（只用 node:zlib）
│   ├── build-pptx.mjs        ④ brief.json → .pptx（内置溢出校验，fail-fast）
│   ├── brief-to-md.mjs       ④ brief.json → .md
│   ├── export-preview.mjs    ⑤ pptx → PNG 预览（视觉验证用）
│   ├── serve.mjs             ★ 手动触发生成服务（零依赖 HTTP，单并发队列）
│   ├── install-into.mjs      ★ 一键插进别的项目（full/data/spec 三模式 + 拷后自检）
│   └── test-render.mjs       渲染回归测试（17 项断言）
├── tests/
│   ├── brief.sample.json     回归测试 fixture
│   └── test-report.txt       上次测试报告（带时间戳）
├── config/sources.json       数据源 + 分类关键词 + 多源阈值
├── config/models.json        模型 / 编码助手 / 具身智能公司关键词（图表用）
├── schema/brief.schema.json  brief.json 的 JSON Schema
├── templates/brief.template.json   空白模板
└── data/YYYY-MM-DD/{news.json, brief.json}
```

---

## 一条命令接入别的项目

```bash
node scripts/install-into.mjs --target <目标项目根目录> [--mode full|data|spec]
```

| 模式 | 装什么 | 依赖 |
|---|---|---|
| `full`（默认） | 全部：抓取 + 选稿 + 渲染 + 服务 + 文档 + 技能文件 | `npm install`（只装 pptxgenjs） |
| `data` | 抓取四件套 + `config/sources.json` | **零依赖，不用装** |
| `spec` | `SKILL.md` + 置信度/数据契约/作业手册 | 无 |

安装器跳过 `node_modules` 与历史 `data/`，自动放技能文件，**拷完立刻自检**
（文件齐全 + `node --check` 语法 + frontmatter），失败 exit 1 并列出缺什么。

不需要改任何脚本路径 —— 全部基于 `__dirname` 解析。
详见 [05-接入其他项目.md](./docs/05-接入其他项目.md) 与 [10-我是如何工作的.md](./docs/10-我是如何工作的.md)。

---

## 三条最重要的纪律

1. **置信度只按「独立信源数」判定，转载不算独立信源。**
   这是本项目唯一的护城河，不许为了「看起来更可信」而放宽。宁可多标几个 C。
2. **`brief.json` 是唯一真相源。** 内容错了只可能是它错了。要改内容改它，不要改渲染脚本。
3. **宁可不产出，也不产出「生成一半的 PPT」。** 渲染失败就只出 Markdown 并写明降级原因。
4. **渲染器只渲染，不做计算。** 图表数据必须来自 `brief.charts`（analyze.mjs 产出）。
   否则同一份 brief 换个渲染器就会得到不同图表 —— 这是「唯一真相源」的另一半含义。

---

## License

MIT
