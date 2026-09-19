/* ============================================================
   AIHub 落地站 · 早报生成控制台（只在 briefing.html 加载）

   升级点（2026-09-19）：
     - 自动按域名切换 API：本机 localhost → 127.0.0.1:8787；公网 → Vercel 后端
     - 首次点击：弹出 DeepSeek API Key 输入框（默认模型 deepseek-chat，可选 v4.1-flash/reasoner）
     - API Key 通过 X-Api-Key header 传给 Vercel，Vercel 用它调 DeepSeek 做 Agent 选稿
     - Key 存 localStorage，用户刷新不丢

   ⚠ 刻意**不做**的事：不画假进度条。
   ============================================================ */
(function () {
  "use strict";

  var root = document.querySelector("[data-gen]");
  if (!root) return;

  /* ---------- 常量 ---------- */
  var DEFAULTS = {
    localApi:    "http://127.0.0.1:8787",
    prodApi:     "https://ai-hub-landing.vercel.app",
    storeKeyApi:    "aihub.gen.api",
    storeKeyKey:   "aihub.gen.apikey",
    storeKeyModel:  "aihub.gen.model",
    pollEvery:   700,
    pollLimit:   900,
    reqTimeout:  20000,
    defaultModel: "deepseek-chat",
    modelOptions: [
      { value: "deepseek-chat",   label: "DeepSeek V3（主力）" },
      { value: "deepseek-reasoner", label: "DeepSeek R1（推理）" },
    ],
  };

  /* ---------- 服务地址（自动域名切换） ---------- */
  function isLocalhost() {
    var h = location.hostname;
    return !h || h === "localhost" || h === "127.0.0.1" || h === "0.0.0.0" || h === "" || h === "[::]";
  }
  function smartDefault() {
    return isLocalhost() ? DEFAULTS.localApi : DEFAULTS.prodApi;
  }
  function apiBase() {
    var q = null;
    try { q = new URLSearchParams(location.search).get("api"); } catch (e) {}
    var pick = q || window.AIHUB_GEN_API || root.getAttribute("data-gen-api");
    if (pick) {
      try { localStorage.setItem(DEFAULTS.storeKeyApi, pick); } catch (e) {}
      return String(pick).replace(/\/+$/, "");
    }
    try {
      var saved = localStorage.getItem(DEFAULTS.storeKeyApi);
      if (saved) return String(saved).replace(/\/+$/, "");
    } catch (e) {}
    return smartDefault();
  }
  var API = apiBase();

  /* ---------- API Key 管理 ---------- */
  function getStoredKey() {
    try { return localStorage.getItem(DEFAULTS.storeKeyKey) || ""; } catch (e) { return ""; }
  }
  function setStoredKey(key) {
    try { localStorage.setItem(DEFAULTS.storeKeyKey, key || ""); } catch (e) {}
  }
  function getStoredModel() {
    try { return localStorage.getItem(DEFAULTS.storeKeyModel) || DEFAULTS.defaultModel; } catch (e) { return DEFAULTS.defaultModel; }
  }
  function setStoredModel(model) {
    try { localStorage.setItem(DEFAULTS.storeKeyModel, model || DEFAULTS.defaultModel); } catch (e) {}
  }
  function hasStoredKey() {
    return getStoredKey().length > 0;
  }

  /* ---------- DOM ---------- */
  var $ = function (sel) { return root.querySelector(sel); };
  var elStatus     = $("[data-gen-status]");
  var elStatusText = $("[data-gen-status-text]");
  var elDate       = $("[data-gen-date]");
  var elMode       = $("[data-gen-mode]");
  var elNoFetch    = $("[data-gen-nofetch]");
  var elGo         = $("[data-gen-go]");
  var elGoLabel    = $("[data-gen-go-label]");
  var elHint       = $("[data-gen-hint]");
  var elPanel      = $("[data-gen-panel]");
  var elSteps      = $("[data-gen-steps]");
  var elResult     = $("[data-gen-result]");

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtSize(n) {
    if (!n) return "";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function setStatus(state, text) {
    if (elStatus) elStatus.setAttribute("data-state", state);
    if (elStatusText) elStatusText.textContent = text;
  }
  function setHint(html, state) {
    if (!elHint) return;
    elHint.innerHTML = html;
    if (state) elHint.setAttribute("data-state", state);
    else elHint.removeAttribute("data-state");
  }

  /* ---------- API Key 弹窗（首次点击触发） ---------- */
  var modalEl = null;

  function showKeyModal(onSave) {
    if (modalEl) { modalEl.remove(); modalEl = null; }
    var modelOptions = DEFAULTS.modelOptions.map(function (m) {
      return '<option value="' + esc(m.value) + '">' + esc(m.label) + "</option>";
    }).join("");
    var currentModel = getStoredModel();
    var currentKey = getStoredKey();
    var savedSelected = currentModel ? ' value="' + esc(currentModel) + '"' : "";

    modalEl = document.createElement("div");
    modalEl.id = "genx-key-modal";
    modalEl.setAttribute("role", "dialog");
    modalEl.setAttribute("aria-modal", "true");
    modalEl.setAttribute("aria-labelledby", "genx-key-title");
    modalEl.style.cssText = [
      "position:fixed","inset:0","z-index:9999",
      "background:rgba(0,0,0,0.5)","display:flex","align-items:center",
      "justify-content:center","padding:16px","font-family:inherit"
    ].join(";");
    modalEl.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:32px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.15)">' +
        '<h2 id="genx-key-title" style="margin:0 0 8px;font-size:18px;font-weight:600;color:#111">配置生成参数</h2>' +
        '<p style="margin:0 0 24px;font-size:14px;color:#6b7280;line-height:1.6">第一次使用需要配置 DeepSeek API Key。<a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener" style="color:#2563eb">去获取 Key →</a></p>' +
        '<div style="margin-bottom:16px">' +
          '<label for="genx-api-key" style="display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:6px">DeepSeek API Key</label>' +
          '<input id="genx-api-key" type="password" placeholder="sk-xxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false"' +
          ' style="width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none"' +
          ' onfocus="this.style.borderColor=\'#F43F5E\'" onblur="this.style.borderColor=\'#e5e7eb\'">' +
          '<div id="genx-key-error" style="color:#dc2626;font-size:12px;margin-top:4px;display:none"></div>' +
        '</div>' +
        '<div style="margin-bottom:24px">' +
          '<label for="genx-model" style="display:block;font-size:13px;font-weight:500;color:#374151;margin-bottom:6px">模型</label>' +
          '<select id="genx-model" style="width:100%;padding:10px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:14px;box-sizing:border-box;background:#fff;outline:none">' +
            modelOptions +
          '</select>' +
          '<div style="font-size:12px;color:#9ca3af;margin-top:4px">主力选 deepseek-chat；需要推理选 deepseek-reasoner（R1）。</div>' +
        '</div>' +
        '<div style="display:flex;gap:10px">' +
          '<button id="genx-key-save" type="button" style="flex:1;padding:10px;background:#F43F5E;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">保存并开始生成</button>' +
          '<button id="genx-key-skip" type="button" style="padding:10px 16px;background:#f3f4f6;color:#374151;border:1px solid #e5e7eb;border-radius:8px;font-size:14px;cursor:pointer">只用机器草稿</button>' +
        '</div>' +
        '<div style="margin-top:16px;padding:12px;background:#f0f9ff;border-radius:8px;font-size:12px;color:#0369a1;line-height:1.6">' +
          '<strong>隐私说明：</strong>Key 只发往 Vercel 后端，不经过 GitHub Pages 前端服务器。后端用它调 DeepSeek API 生成选稿，Key 不会写日志或转发给第三方。' +
        '</div>' +
      '</div>';
    document.body.appendChild(modalEl);

    var inputEl = modalEl.querySelector("#genx-api-key");
    var modelEl = modalEl.querySelector("#genx-model");
    var saveBtn = modalEl.querySelector("#genx-key-save");
    var skipBtn = modalEl.querySelector("#genx-key-skip");
    var errEl  = modalEl.querySelector("#genx-key-error");

    if (currentKey) inputEl.value = currentKey;
    if (currentModel) modelEl.value = currentModel;
    inputEl.focus();

    function closeModal() {
      if (modalEl) { modalEl.remove(); modalEl = null; }
    }
    function save(mode) {
      var key = inputEl.value.trim();
      var model = modelEl.value;
      if (mode === "agent" && !key) {
        errEl.textContent = "请输入 DeepSeek API Key，或点「只用机器草稿」跳过。";
        errEl.style.display = "block";
        return;
      }
      if (key) setStoredKey(key);
      setStoredModel(model);
      closeModal();
      onSave(key, model);
    }

    saveBtn.addEventListener("click", function () { save("agent"); });
    skipBtn.addEventListener("click", function () { save("draft"); });
    inputEl.addEventListener("keydown", function (e) { if (e.key === "Enter") saveBtn.click(); });
    modalEl.addEventListener("click", function (e) { if (e.target === modalEl) closeModal(); });
  }

  /* ---------- 请求（带超时；支持 X-Api-Key header） ---------- */
  var _currentKey = getStoredKey();
  var _currentModel = getStoredModel();

  function call(path, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || DEFAULTS.reqTimeout;
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = window.setTimeout(function () { if (ctl) ctl.abort(); }, timeoutMs);
    var init = { method: opts.method || "GET", signal: ctl ? ctl.signal : undefined };
    var headers = { "Content-Type": "application/json" };
    if (_currentKey) headers["X-Api-Key"] = _currentKey;
    if (_currentModel) headers["X-Model"] = _currentModel;
    init.headers = headers;
    if (opts.body) {
      init.body = JSON.stringify(opts.body);
    }
    return fetch(API + path, init)
      .then(function (r) {
        window.clearTimeout(timer);
        return r.text().then(function (t) {
          var data = null;
          try { data = JSON.parse(t); } catch (e) { data = { raw: t }; }
          return { status: r.status, ok: r.ok, data: data };
        });
      })
      .catch(function (e) {
        window.clearTimeout(timer);
        var msg = e && e.name === "AbortError" ? "请求超时" : (e && e.message) || "网络错误";
        throw new Error(msg);
      });
  }

  /* ---------- 日期工具 ---------- */
  function localToday() {
    try {
      var p = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
      }).formatToParts(new Date());
      var o = {};
      p.forEach(function (x) { o[x.type] = x.value; });
      return o.year + "-" + o.month + "-" + o.day;
    } catch (e) {
      var d = new Date();
      var pad = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    }
  }

  function fillDates(today, dates) {
    if (!elDate) return;
    var list = [];
    if (today) list.push(today);
    (dates || []).forEach(function (d) { if (list.indexOf(d) === -1) list.push(d); });
    if (!list.length) list.push(localToday());
    elDate.innerHTML = list
      .map(function (d) { return '<option value="' + esc(d) + '">' + esc(d) + "</option>"; })
      .join("");
    elDate.value = list[0];
  }

  /* ---------- 状态徽标渲染 ---------- */
  var MARK = {
    pending: "○", running: "◌", done: "✓",
    skip: "–", warn: "!", error: "✕",
  };
  function renderSteps(job) {
    if (!elSteps) return;
    if (!job || !job.steps) { elSteps.innerHTML = ""; return; }
    elSteps.innerHTML = job.steps
      .map(function (s) {
        var detail = s.detail ? '<span class="genx-step__detail">' + esc(s.detail) + "</span>" : "";
        var ms = s.ms ? '<span class="genx-step__ms">' + (s.ms / 1000).toFixed(1) + "s</span>" : "";
        return (
          '<li class="genx-step" data-state="' + esc(s.status) + '">' +
          '<span class="genx-step__mark" aria-hidden="true">' + (MARK[s.status] || "○") + "</span>" +
          '<span class="genx-step__label">' + esc(s.label) + "</span>" +
          detail + ms +
          "</li>"
        );
      })
      .join("");
  }

  function lvBadge(lv) {
    return '<span class="genx-lv genx-lv--' + esc(lv) + '">' + esc(lv) + "</span>";
  }

  function b64ToBlob(b64, mime) {
    var bin = atob(b64 || "");
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function mdTextToBlob(text, mime) {
    return new Blob([text || ""], { type: mime });
  }

  function renderResult(job) {
    if (!elResult) return;
    var r = job.result || {};
    var isDraft = r.mode === "draft";
    var pptxName = (r.pptx && r.pptx.name) || ("AI日报_" + r.date + (isDraft ? "_机器草稿" : "") + ".pptx");
    var mdName = (r.md && r.md.name) || ("AI新闻推送_" + r.date + (isDraft ? "_机器草稿" : "") + ".md");

    var pptxBlob = null, mdBlob = null;
    if (r.pptxB64) pptxBlob = b64ToBlob(r.pptxB64, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    if (r.mdB64)   mdBlob   = mdTextToBlob(r.mdB64, "text/markdown;charset=utf-8");

    var dlPptxFallback = API + "/api/download?date=" + encodeURIComponent(r.date) + "&kind=pptx" + (isDraft ? "&draft=1" : "");
    var dlMdFallback   = API + "/api/download?date=" + encodeURIComponent(r.date) + "&kind=md"   + (isDraft ? "&draft=1" : "");

    function attachDownload(anchor, blob, fallbackUrl) {
      if (!anchor) return;
      if (blob) {
        var url = URL.createObjectURL(blob);
        anchor.href = url;
        anchor.setAttribute("download", anchor.getAttribute("data-name") || "");
        anchor.addEventListener("click", function () {
          setTimeout(function () { URL.revokeObjectURL(url); }, 60_000);
        }, { once: true });
      } else {
        anchor.href = fallbackUrl;
        anchor.setAttribute("download", "");
      }
    }

    var warnHtml = (job.warnings || []).length
      ? '<ul class="genx-warn">' + job.warnings.map(function (w) { return "<li>" + esc(w) + "</li>"; }).join("") + "</ul>"
      : "";

    elResult.innerHTML =
      '<div class="genx-result__top">' +
        '<span class="genx-chip genx-chip--' + (isDraft ? "warn" : "ok") + '">' +
          (isDraft ? "机器草稿" : "Agent 选稿") +
        "</span>" +
        '<span class="genx-result__meta">' +
          esc(r.date) + " · " + (r.pages != null ? r.pages + " 页" : "页数未知") + " · " + esc(fmtSize(r.pptx && r.pptx.bytes)) +
        "</span>" +
      "</div>" +
      '<p class="genx-result__note">' +
        (isDraft
          ? "这次没有 Agent 选稿，走的是机器草稿：条目由机器按「时效 + 分类」直出，<strong>没有写点评、没有核验一手来源、没有查重</strong>，PPT 封面与每一页页脚都打了「机器草稿」标记。"
          : "这次用的是 Agent 选稿（deepseek-chat），置信度经过 A/B/C/D 分级，渲染前已过业务规则校验。") +
      "</p>" +
      warnHtml +
      '<div class="genx-downloads">' +
        '<a class="btn btn--primary btn--sm" data-gen-dl-pptx data-name="' + esc(pptxName) + '" href="' + esc(dlPptxFallback) + '" download>下载 PPTX</a>' +
        '<a class="btn btn--secondary btn--sm" data-gen-dl-md data-name="' + esc(mdName) + '" href="' + esc(dlMdFallback) + '" download>下载 Markdown</a>' +
        '<span class="genx-result__file">' + esc(pptxName) + "</span>" +
      "</div>" +
      '<div class="genx-picks" data-gen-picks></div>';

    attachDownload(elResult.querySelector("[data-gen-dl-pptx]"), pptxBlob, dlPptxFallback);
    attachDownload(elResult.querySelector("[data-gen-dl-md]"),   mdBlob,   dlMdFallback);

    renderPicks(r.date);
  }

  function renderPicks(date) {
    var box = elResult && elResult.querySelector("[data-gen-picks]");
    if (!box) return;
    call("/api/brief?date=" + encodeURIComponent(date))
      .then(function (res) {
        if (!res.ok || !res.data || !res.data.picks) { box.innerHTML = ""; return; }
        var picks = res.data.picks;
        box.innerHTML =
          '<div class="genx-picks__head">本次选中 ' + picks.length + " 条 · " +
          (res.data.draft ? "机器草稿" : "Agent 选稿") + "</div>" +
          '<ul class="genx-picks__list">' +
          picks.map(function (p) {
            return (
              "<li>" + lvBadge(p.lv) +
              '<span class="genx-picks__topic">' + esc(p.topic) + "</span>" +
              '<span class="genx-picks__title">' + esc(p.title) + "</span></li>"
            );
          }).join("") +
          "</ul>";
      })
      .catch(function () { box.innerHTML = ""; });
  }

  /* ---------- 生成流程 ---------- */
  var polling = false;

  function busy(on) {
    if (elGo) {
      elGo.disabled = !!on;
      elGo.setAttribute("aria-busy", on ? "true" : "false");
    }
    if (elGoLabel) elGoLabel.textContent = on ? "正在生成…" : "立即生成今日早报";
  }

  function doGenerate() {
    if (polling) return;
    var date = elDate ? elDate.value : null;
    var mode = elMode ? elMode.value : "auto";
    var noFetch = elNoFetch && elNoFetch.checked;

    polling = true;
    busy(true);
    if (elPanel) elPanel.hidden = false;
    if (elResult) elResult.innerHTML = "";
    renderSteps(null);
    setStatus("busy", "正在生成…");
    setHint("已提交任务，正在执行流水线。这一步是真实运行，不要关页面。", "busy");

    // 凭证随 POST body 传，后端用它们调 DeepSeek
    // Vercel Serverless 跨实例内存不共享 → 后端改为同步阻塞模式（最长 270s），前端 reqTimeout 也提到 280s
    call("/api/generate", { method: "POST", body: { date: date, mode: mode, noFetch: noFetch, force: true, apiKey: _currentKey, model: _currentModel }, timeoutMs: 280000 })
      .then(function (res) {
        if (!res.ok || !res.data) {
          throw new Error((res.data && res.data.error) || "服务返回 " + res.status);
        }
        var job = res.data.job;
        if (!job) throw new Error("服务没返回 job 对象");
        renderSteps(job);
        if (job.status === "done") return finish(job);
        if (job.status === "error") return failed(job);
        throw new Error("未知 job 状态：" + job.status);
      })
      .catch(function (e) {
        polling = false;
        busy(false);
        setStatus("error", "生成失败");
        var msg = String(e && e.message ? e.message : e);
        if (/Failed to fetch|NetworkError|Load failed|网络错误|请求超时/.test(msg)) {
          setHint(startHelpHtml(msg), "error");
        } else {
          setHint("<strong>生成失败：</strong>" + esc(msg), "error");
        }
      });
  }

  function generate() {
    // 没有 API Key → 弹出输入框
    if (!hasStoredKey() && isLocalhost()) {
      showKeyModal(function (key, model) {
        _currentKey = key;
        _currentModel = model;
        // 强制走 agent 模式（有 key）或 auto（无 key 时自动降级）
        if (elMode) elMode.value = key ? "agent" : "auto";
        doGenerate();
      });
    } else {
      _currentKey = getStoredKey();
      _currentModel = getStoredModel();
      doGenerate();
    }
  }

  function poll() {
    /* 旧的轮询函数已废弃——Vercel Serverless 跨实例内存不共享，job 状态无法跨请求追踪。
       现在 /api/generate 是同步阻塞模式，跑完直接返回完整 job 对象。保留空函数以防误调。 */
    throw new Error("poll() 已废弃，请刷新页面（前端已切换到同步阻塞模式）");
  }

  function finish(job) {
    polling = false;
    busy(false);
    var isDraft = job.result && job.result.mode === "draft";
    setStatus(isDraft ? "warn" : "ok", isDraft ? "完成（机器草稿）" : "完成（Agent 选稿）");
    setHint(
      isDraft
        ? "已产出 PPTX 与 Markdown，但这次是<strong>机器草稿</strong>。"
        : "已产出 PPTX 与 Markdown，选稿来自 Agent 的判断。",
      isDraft ? "warn" : "ok"
    );
    renderResult(job);
    revealConsole();
  }

  function revealConsole() {
    var r = root.getBoundingClientRect();
    var out = r.top < 0 || r.bottom > window.innerHeight;
    if (!out) return;
    var html = document.documentElement;
    var prev = html.style.scrollBehavior;
    var instant = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (instant) html.style.scrollBehavior = "auto";
    window.scrollTo({ top: window.scrollY + r.top - 80, behavior: instant ? "auto" : "smooth" });
    if (instant) html.style.scrollBehavior = prev;
  }

  function failed(job) {
    polling = false;
    busy(false);
    setStatus("error", job.phase || "生成失败");
    setHint(
      "<strong>" + esc(job.phase || "生成失败") + "：</strong><br><code class=\"genx-err\">" +
      esc(job.error || "服务未给出原因") + "</code>",
      "error"
    );
    renderSteps(job);
  }

  /* ---------- 首屏：探服务 + 铺日期 ---------- */
  function startHelpHtml(reason) {
    var isLoc = isLocalhost();
    return (
      '<strong>生成服务没连上</strong>（' + esc(reason) + '）。' +
      (isLoc
        ? '本页跑在本地，默认连 <code>127.0.0.1:8787</code>。到项目里起一次服务再刷新：' +
          '<div class="genx-cmd"><code>node ai-news-kit/scripts/serve.mjs</code></div>' +
          '<span class="genx-hint__foot">若本机开着系统代理（Clash 之类）而没把 <code>127.0.0.1</code> 加进绕过列表，浏览器会拒连。</span>'
        : '本页跑在 GitHub Pages，公网后端是 <code>' + esc(API) + '</code>。' +
          '如果 Vercel 项目正在冷启动，等几秒后刷新本页。' +
          '<div class="genx-cmd"><code>' + esc(API) + '/api/health</code></div>')
    );
  }

  function boot() {
    setStatus("idle", "正在检查生成服务…");
    return call("/api/health")
      .then(function (res) {
        if (!res.ok || !res.data || !res.data.ok) throw new Error("服务返回 " + res.status);
        var h = res.data;
        setStatus("ok", "生成服务在线 · v" + h.version);
        var st = h.todayState || {};
        var state = st.hasBrief
          ? "今天已有 Agent 选稿，默认会用它。"
          : st.hasNews
            ? "今天只有抓取数据，还没有 Agent 选稿 —— 直接生成会走「机器草稿」。"
            : "今天还没抓过数据，点按钮会先抓一遍。";
        setHint(
          "服务在线（<code>" + esc(API) + "</code>），默认日期 " + esc(h.today) + "。" + state +
          "<br>生成过程真实执行抓取与渲染，通常十几秒到半分钟。",
          st.hasBrief ? "ok" : "warn"
        );
        return call("/api/history").then(function (hr) {
          var dates = (hr.data && hr.data.items ? hr.data.items : []).map(function (x) { return x.date; });
          fillDates(h.today, dates);
        });
      })
      .catch(function (e) {
        setStatus("error", "生成服务未启动");
        setHint(startHelpHtml(e && e.message ? e.message : "连接失败"), "error");
        fillDates(null, []);
      });
  }

  if (elGo) elGo.addEventListener("click", generate);
  if (elNoFetch) {
    elNoFetch.addEventListener("change", function () {
      if (!elGo || polling) return;
      if (elNoFetch.checked) setHint("已勾选「跳过抓取」：将复用今天已有的抓取结果，只重跑选稿与渲染。", "ok");
      else boot();
    });
  }

  /* 深链：?autogen=1 打开即生成；加 &nofetch=1 跳过抓取 */
  var AUTOGEN = false;
  try {
    var qs = new URLSearchParams(location.search);
    AUTOGEN = qs.get("autogen") === "1";
    if (qs.get("nofetch") === "1" && elNoFetch) elNoFetch.checked = true;
  } catch (e) {}

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }

  function onReady() {
    _currentKey = getStoredKey();
    _currentModel = getStoredModel();
    boot().then(function () {
      if (AUTOGEN) generate();
    });
  }
})();
