/* ============================================================
   AIHub 落地站 · Artificial Analysis 实时模型榜单（只在 features.html 加载）

   数据从哪来：
     tools/fetch-aa-rankings.mjs 抓 artificialanalysis.ai 首页的公开结构化数据
     （React Flight 流里的 schema.org Dataset），生成 assets/js/aa-rankings-data.js。
     本文件只负责画图 —— 数据与渲染分离，重抓数据不用改这里。

   为什么自绘而不是「扣图」：
     AA 的图是 ECharts 现画的，页面上没有静态图片可下载；热链他们的图
     拿不到、也会失效。扣数据自己画，风格能跟站点对齐，还能按需改。

   图表口径（务必如实展示）：
     · 智能指数   = AA 自家评测聚合（0-100），越高越好
     · 输出速度   = 中位输出 tokens/s，越高越好
     · 每任务成本 = 智能指数单任务成本（美元），**越低越好**（排序为升序）
     都是 AA 首页图表的口径（约前 11 名），不是全量 314 个模型。
   ============================================================ */
(function () {
  "use strict";

  var root = document.querySelector("[data-aa-rankings]");
  if (!root) return;
  var data = window.AA_RANKINGS;
  if (!data || !Array.isArray(data.charts)) {
    root.innerHTML = '<p class="aa-missing">榜单数据未生成：到项目里跑 <code>node tools/fetch-aa-rankings.mjs</code>。</p>';
    return;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmt(v, key) {
    if (key === "medianOutputSpeed") return v.toFixed(0) + " t/s";
    if (key === "costPerIntelligenceIndexTask") return "$" + v.toFixed(2);
    return v.toFixed(1);
  }

  function hint(key) {
    if (key === "costPerIntelligenceIndexTask") return "成本 · 越低越好";
    if (key === "medianOutputSpeed") return "速度 · 越高越好";
    return "能力 · 越高越好";
  }

  function chartSVG(chart) {
    var W = 640, padL = 236, padR = 62, padT = 6, rowH = 40, padB = 6;
    var items = chart.items;
    var n = items.length;
    var H = padT + rowH * n + padB;
    var max = 0;
    for (var i = 0; i < n; i++) max = Math.max(max, items[i].value);
    var inner = W - padL - padR;

    var s = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(chart.label) + ' 排行">';
    for (var j = 0; j < n; j++) {
      var it = items[j];
      var y = padT + j * rowH;
      var bw = Math.max(3, (it.value / max) * inner);
      var label = it.label.length > 30 ? it.label.slice(0, 29) + "…" : it.label;
      s += '<g>'
        + '<text class="aa-chart__label" x="0" y="' + (y + rowH / 2 + 3.5) + '">' + esc(label) + "</text>"
        + '<rect class="aa-chart__track" x="' + padL + '" y="' + (y + rowH / 2 - 9) + '" width="' + inner + '" height="18" rx="9"></rect>'
        + '<rect class="aa-chart__bar' + (j === 0 ? " aa-chart__bar--top" : "") + '" x="' + padL + '" y="' + (y + rowH / 2 - 9)
        + '" width="' + bw.toFixed(1) + '" height="18" rx="9"><title>' + esc(it.label) + "</title></rect>"
        + '<text class="aa-chart__value" x="' + W + '" y="' + (y + rowH / 2 + 3.5) + '" text-anchor="end">' + fmt(it.value, chart.key) + "</text>"
        + "</g>";
    }
    return s + "</svg>";
  }

  var html = "";
  data.charts.forEach(function (c) {
    html +=
      '<figure class="aa-chart">'
      + '<figcaption class="aa-chart__head">'
      + '<span class="aa-chart__title">' + esc(c.label) + "</span>"
      + '<span class="aa-chart__hint">' + esc(hint(c.key)) + " · " + esc(c.unit) + "</span>"
      + "</figcaption>"
      + chartSVG(c)
      + (c.items[0] && c.items[0].url
        ? '<a class="aa-chart__link" href="' + esc(c.items[0].url) + '" target="_blank" rel="noopener noreferrer">在 Artificial Analysis 查看 ↗</a>'
        : "")
      + "</figure>";
  });
  root.innerHTML = html;

  // 数据口径与抓取时间（透明：不是我们评的，是 AA 的口径，且写明什么时候抓的）
  var meta = document.querySelector("[data-aa-meta]");
  if (meta) {
    var when = "—";
    try {
      when = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(new Date(data.fetchedAt));
    } catch (e) {}
    meta.innerHTML =
      "数据来源：<a href=\"https://artificialanalysis.ai/zh\" target=\"_blank\" rel=\"noopener noreferrer\">Artificial Analysis</a>"
      + "（公开结构化数据，非本站评测） · 抓取时间 " + esc(when) + "（GMT+8） · 口径为 AA 首页图表（约前 11 名），"
      + "不是全量模型。重抓：<code>node tools/fetch-aa-rankings.mjs</code>";
  }
})();
