/* ============================================================
   AIHub 落地站 · 全站公用脚本（零依赖）
   以下 12 项在**全部 8 个页面**生效；页面专属逻辑另开文件（见文末说明）。
   1. 打字机 Hero（data-typewriter，| 分段）
   2. 导航滚动态 + 顶部阅读进度条（JS 注入，免改多页 HTML）
   3. 移动端抽屉（焦点陷阱 / ESC / resize 自动收起）
   4. 滚动入场（IntersectionObserver + stagger）
   5. 数字滚动（data-count-to，easeOutCubic）
   6. FAQ 手风琴（单组单选）
   7. 代码块复制
   8. 卡片聚光灯（指针位置写入 --mx / --my）
   9. 页脚实时时钟（UTC+8）
   10. 返回顶部按钮（JS 注入）
  11. 全局鼠标光晕（JS 注入 .cursor-glow，位置写入 --cursor-x / --cursor-y）
  12. 调参面板（点左上角 logo 开关，注入 .tw-panel；样式在 components.css 第 26 节）
  全部动效尊重 prefers-reduced-motion。

  以下是**页面专属**脚本，不在这里（保持本文件「每页都要」的定位）：
  · assets/js/generate.js —— 早报生成控制台，只在 briefing.html 加载，
    要发请求、要轮询，塞进来会让无关页面也背上一份网络逻辑。
   ============================================================ */
(function () {
  "use strict";

  /* 标记 JS 可用：配合 CSS 的 html:not(.js) .reveal 兜底，
     若脚本未执行则所有入场元素默认可见，内容不丢失。 */
  document.documentElement.classList.add("js");

  var reduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. 打字机 Hero ---------- */
  function runTypewriter(el) {
    var text = el.getAttribute("data-typewriter") || "";
    if (!text) return;
    if (reduced) {
      el.textContent = text.replace(/\|/g, "");
      return;
    }
    var segments = text.split("|");
    el.textContent = "";
    el.classList.add("tw-active");

    var segIndex = 0;
    function typeNext() {
      if (segIndex >= segments.length) return;
      var cursor = el.querySelector(".tw-cursor");
      if (!cursor) {
        cursor = document.createElement("span");
        cursor.className = "tw-cursor";
        cursor.setAttribute("aria-hidden", "true");
        el.appendChild(cursor);
      }
      var seg = segments[segIndex];
      var j = 0;
      function typeChar() {
        if (j >= seg.length) {
          segIndex++;
          if (segIndex < segments.length) {
            window.setTimeout(typeNext, 180);
          }
          return;
        }
        el.insertBefore(document.createTextNode(seg.charAt(j)), cursor);
        j++;
        window.setTimeout(typeChar, 35 + Math.random() * 75);
      }
      typeChar();
    }
    typeNext();
  }
  function initTypewriters() {
    var els = Array.prototype.slice.call(
      document.querySelectorAll("[data-typewriter]")
    );
    if (!els.length) return;
    if (!("IntersectionObserver" in window)) {
      els.forEach(function (el) {
        el.textContent = (el.getAttribute("data-typewriter") || "").replace(/\|/g, "");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            runTypewriter(entry.target);
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.3 }
    );
    els.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- 2. 导航滚动态 + 阅读进度条 ---------- */
  var nav = document.querySelector(".nav");
  var progress = null;
  if (nav && !nav.querySelector(".nav__progress")) {
    progress = document.createElement("div");
    progress.className = "nav__progress";
    progress.setAttribute("aria-hidden", "true");
    nav.appendChild(progress);
  }
  var toTop = null;
  if (!document.querySelector(".to-top")) {
    toTop = document.createElement("button");
    toTop.className = "to-top";
    toTop.type = "button";
    toTop.setAttribute("aria-label", "返回顶部");
    toTop.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
    document.body.appendChild(toTop);
    toTop.addEventListener("click", function () {
      if (reduced) {
        window.scrollTo(0, 0);
        return;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }
  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      var y = window.scrollY || 0;
      if (nav) {
        if (y > 8) nav.classList.add("is-scrolled");
        else nav.classList.remove("is-scrolled");
      }
      if (progress) {
        var doc = document.documentElement;
        var max = doc.scrollHeight - window.innerHeight;
        var p = max > 0 ? Math.min(y / max, 1) : 0;
        progress.style.transform = "scaleX(" + p + ")";
      }
      if (toTop) {
        if (y > 600) toTop.classList.add("is-shown");
        else toTop.classList.remove("is-shown");
      }
      ticking = false;
    });
  }

  /* ---------- 3. 移动端抽屉（焦点陷阱） ---------- */
  var toggle = document.querySelector(".nav__toggle");
  var drawer = document.querySelector(".nav__drawer");
  var lastFocused = null;
  function closeDrawer() {
    if (!drawer || !drawer.classList.contains("is-open")) return;
    drawer.classList.remove("is-open");
    if (toggle) {
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "打开导航菜单");
    }
    document.body.style.overflow = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    lastFocused = null;
  }
  if (toggle && drawer) {
    toggle.addEventListener("click", function () {
      var open = drawer.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      toggle.setAttribute("aria-label", open ? "关闭导航菜单" : "打开导航菜单");
      document.body.style.overflow = open ? "hidden" : "";
      if (open) {
        lastFocused = document.activeElement;
        var first = drawer.querySelector("a, button");
        if (first) first.focus();
      }
    });
    drawer.addEventListener("click", function (e) {
      if (e.target.closest("a")) closeDrawer();
    });
    /* 焦点陷阱：Tab 循环留在抽屉内 */
    drawer.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var focusables = Array.prototype.slice.call(
        drawer.querySelectorAll("a[href], button:not([disabled])")
      );
      if (!focusables.length) return;
      var first = focusables[0];
      var last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDrawer();
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth >= 768) closeDrawer();
  });

  /* ---------- 4. 滚动入场 + 自动 stagger ---------- */
  Array.prototype.slice
    .call(document.querySelectorAll("[data-stagger]"))
    .forEach(function (group) {
      var step = parseInt(group.getAttribute("data-stagger"), 10) || 60;
      var kids = Array.prototype.slice.call(group.querySelectorAll(".reveal"));
      kids.forEach(function (el, i) {
        if (!el.hasAttribute("data-delay")) el.setAttribute("data-delay", String(i * step));
      });
    });
  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (reduced || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) {
      el.classList.add("is-visible");
    });
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var el = entry.target;
            var delay = el.getAttribute("data-delay")
              ? parseInt(el.getAttribute("data-delay"), 10)
              : 0;
            window.setTimeout(function () {
              el.classList.add("is-visible");
            }, delay);
            io.unobserve(el);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- 5. 数字滚动（data-count-to） ---------- */
  function initCounters() {
    var els = Array.prototype.slice.call(
      document.querySelectorAll("[data-count-to]")
    );
    if (!els.length) return;
    var setFinal = function (el) {
      el.textContent = el.getAttribute("data-count-to") || "";
    };
    if (reduced || !("IntersectionObserver" in window)) {
      els.forEach(setFinal);
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var el = entry.target;
          var target = parseFloat(el.getAttribute("data-count-to"));
          if (isNaN(target)) {
            io.unobserve(el);
            return;
          }
          var dur = 1100;
          var start = null;
          function step(t) {
            if (start === null) start = t;
            var k = Math.min((t - start) / dur, 1);
            var eased = 1 - Math.pow(1 - k, 3);
            el.textContent = String(Math.round(target * eased));
            if (k < 1) window.requestAnimationFrame(step);
          }
          window.requestAnimationFrame(step);
          io.unobserve(el);
        });
      },
      { threshold: 0.5 }
    );
    els.forEach(function (el) {
      io.observe(el);
    });
  }

  /* ---------- 6. FAQ 手风琴（单组单选） ---------- */
  var accBtns = Array.prototype.slice.call(document.querySelectorAll(".acc__btn"));
  accBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var expanded = btn.getAttribute("aria-expanded") === "true";
      var group = btn.closest(".accordion");
      if (group) {
        Array.prototype.slice
          .call(group.querySelectorAll(".acc__btn"))
          .forEach(function (other) {
            if (other !== btn) other.setAttribute("aria-expanded", "false");
          });
      }
      btn.setAttribute("aria-expanded", expanded ? "false" : "true");
    });
  });

  /* ---------- 7. 代码块复制 ---------- */
  var copyBtns = Array.prototype.slice.call(document.querySelectorAll(".code__copy"));
  copyBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.closest(".code").querySelector("pre");
      if (!code) return;
      var text = code.innerText || code.textContent;
      var done = function () {
        btn.textContent = "已复制";
        btn.classList.add("is-done");
        window.setTimeout(function () {
          btn.textContent = "复制";
          btn.classList.remove("is-done");
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          done();
        } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });

  /* ---------- 8. 卡片聚光灯（--mx/--my） ---------- */
  /* 局部聚光：只作用在指针所在的那张卡片上，作为被全局光晕掠过的「加强版」 */
  function initSpotlight() {
    if (!window.matchMedia || window.matchMedia("(hover: none)").matches) return;
    var lastCard = null;
    var pending = false;
    var cx = 0;
    var cy = 0;

    function paint() {
      pending = false;
      if (!lastCard) return;
      var rect = lastCard.getBoundingClientRect();
      lastCard.style.setProperty("--mx", (cx - rect.left) + "px");
      lastCard.style.setProperty("--my", (cy - rect.top) + "px");
    }

    document.addEventListener("pointermove", function (e) {
      var card = e.target && e.target.closest ? e.target.closest(".card") : null;
      if (!card) {
        lastCard = null;
        return;
      }
      lastCard = card;
      cx = e.clientX;
      cy = e.clientY;
      if (!pending) {
        pending = true;
        window.requestAnimationFrame(paint);
      }
    }, { passive: true });
  }

  /* ---------- 11. 全局鼠标光晕 ---------- */
  /* 注入一层固定在视口上的柔光，跟着指针走。
     位置只写到光晕元素自己的自定义属性上（不写到 :root），
     避免每次移动都触发整棵文档树的样式重算。 */
  function initCursorGlow() {
    if (!window.matchMedia) return;
    if (window.matchMedia("(hover: none)").matches) return;              /* 触屏无鼠标位置 */
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; /* 尊重减少动效 */

    var glow = document.querySelector(".cursor-glow");
    if (!glow) {
      glow = document.createElement("div");
      glow.className = "cursor-glow";
      glow.setAttribute("aria-hidden", "true");
      document.body.appendChild(glow);
    }

    var pending = false;
    var x = 0;
    var y = 0;

    function paint() {
      pending = false;
      glow.style.setProperty("--cursor-x", x + "px");
      glow.style.setProperty("--cursor-y", y + "px");
    }

    document.addEventListener("pointermove", function (e) {
      if (e.pointerType && e.pointerType !== "mouse") return;            /* 触摸/触控笔不显示 */
      x = e.clientX;
      y = e.clientY;
      if (!glow.classList.contains("is-on")) glow.classList.add("is-on");
      if (!pending) {
        pending = true;
        window.requestAnimationFrame(paint);
      }
    }, { passive: true });

    /* 指针离开窗口 / 窗口失焦：淡出，避免光晕僵在边缘 */
    document.documentElement.addEventListener("pointerleave", function () {
      glow.classList.remove("is-on");
    });
    window.addEventListener("blur", function () {
      glow.classList.remove("is-on");
    });
  }

  /* ---------- 9. FAQ 深链：hash 命中面板则自动展开 ---------- */
  /* ⚠ 这里必须**先判断 hash 是不是一个合法 id**，再交给 querySelector。
     否则像 #panel=on、#1abc 这种非 id 片段会让 querySelector 抛 SyntaxError，
     异常顺着 init() 往上冒，把排在后面的初始化**全部带崩**
     （本项目实测：带 #panel=on 打开页面时，FAQ 深链之后的
       initFaqHashSync() 与 onScroll() 就再也没执行过，而且页面上看不出任何异常）。 */
  function openAccPanel(panel) {
    var btn = document.getElementById(panel.getAttribute("aria-labelledby") || "");
    if (btn) btn.setAttribute("aria-expanded", "true");
  }
  function initFaqDeepLink() {
    if (!location.hash || !/^#[A-Za-z][\w-]*$/.test(location.hash)) return;
    var panel = null;
    try {
      panel = document.querySelector(location.hash);
    } catch (e) {
      return;
    }
    if (panel && panel.classList.contains("acc__panel")) {
      openAccPanel(panel);
      window.setTimeout(function () {
        panel.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      }, 120);
    }
  }
  function initFaqHashSync() {
    document.querySelectorAll(".acc__btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var panelId = btn.getAttribute("aria-controls");
        if (!panelId) return;
        var open = btn.getAttribute("aria-expanded") === "true";
        if (open) {
          history.replaceState(null, "", "#" + panelId);
        } else if (location.hash === "#" + panelId) {
          history.replaceState(null, "", location.pathname + location.search);
        }
      });
    });
  }

  /* ---------- 页脚实时时钟（Asia/Shanghai） ---------- */
  function initClock() {
    var el = document.querySelector("[data-clock]");
    if (!el) return;
    var fmt = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    function tick() {
      el.textContent = fmt.format(new Date());
    }
    tick();
    window.setInterval(tick, 1000);
  }

  /* ---------- 12. 调参面板（点左上角 logo 打开） ---------- */
  /* 为什么把它做进主站：配色/动效有十几个旋钮，只有「在真实页面上边看边拖」
     才好定；之前那套旋钮放在 _spec 的验收页里，两边对照很难受。
     现在点 logo 就能调，拖完点「复制参数」把数值带走即可。
     面板样式在 components.css 第 26 节（那样就不必给 8 个页面各加一张表）。 */
  function initTweakPanel() {
    var root = document.documentElement;
    var brand = document.querySelector(".nav__brand");
    if (!brand || document.querySelector(".tw-panel")) return;

    /* 每个旋钮：range 范围 + 它驱动的令牌 + 显示格式 + 提示。
       ⚠ 默认值**必须**与 tokens.css 的实际取值一致，否则面板一打开就自相矛盾。
       ⚠ 联动倍率也必须与 tokens.css 的实际比例一致（如 CTA = 按钮 ×1.625）。 */
    var CONTROLS = [
      {
        id: "hue",
        label: "颜色变化速度",
        hint: "色相轮转 + 背景冷暖交替，用同一个节拍。数值越小越快",
        min: 8, max: 90, step: 1, value: 28,
        fmt: function (v) { return v + "s"; },
        apply: function (v) {
          root.style.setProperty("--hue-dur", v + "s");
          root.style.setProperty("--aurora-dur-breath", Math.round(v * 27 / 28) + "s");
          root.style.setProperty("--aurora-dur-c", Math.round(v * 21 / 28) + "s");
        }
      },
      {
        id: "flow",
        label: "底色流速",
        hint: "按钮/标题/CTA 的底色往返一趟。数值越小越快",
        min: 5, max: 40, step: 1, value: 11,
        fmt: function (v) { return v + "s"; },
        apply: function (v) {
          root.style.setProperty("--btn-flow-dur", v + "s");
          root.style.setProperty("--grad-pan-dur", Math.round(v * 1.125) + "s");
          root.style.setProperty("--cta-flow-dur", Math.round(v * 1.625) + "s");
        }
      },
      {
        id: "band",
        label: "色带宽度",
        hint: "决定一块底色里同时能看到几个色相；100% 时完全动不起来",
        min: 100, max: 220, step: 5, value: 145,
        fmt: function (v) { return v + "%"; },
        apply: function (v) {
          root.style.setProperty("--grad-band-btn", v + "%");
          root.style.setProperty("--grad-band-text", v + "%");
        }
      },
      {
        id: "veil",
        label: "底色罩",
        hint: "整页唯一那层冷白罩。0.70 = 现值（--ink-4 实测 4.59:1）；再往下小字就不达 AA 了",
        min: 0.30, max: 0.90, step: 0.01, value: 0.70,
        fmt: function (v) { return v.toFixed(2); },
        apply: function (v) {
          var c = canvasRGB();
          root.style.setProperty("--page-veil",
            "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + v.toFixed(2) + ")");
        }
      },
      {
        id: "aurora",
        label: "极光强度",
        hint: "冷暖两套色场整体强度（呼吸的互补关系不受影响）",
        min: 0, max: 1.8, step: 0.05, value: 1,
        fmt: function (v) { return v.toFixed(2); },
        apply: function (v) {
          root.style.setProperty("--aurora-strength", String(v));
        }
      },
      {
        id: "grain",
        label: "噪点强度",
        hint: "给浅色渐变做抖动、消除色带；0 即关闭",
        min: 0, max: 0.3, step: 0.01, value: 0.10,
        fmt: function (v) { return v.toFixed(2); },
        apply: function (v) {
          root.style.setProperty("--grain-opacity", String(v));
        }
      },
      {
        id: "glow",
        label: "光晕浓度",
        hint: "跟随指针那团光。1 = 原始，0.5 = 减半",
        min: 0, max: 2, step: 0.05, value: 0.5,
        fmt: function (v) { return v.toFixed(2); },
        apply: function (v) {
          root.style.setProperty("--cursor-glow-tint", String(v));
        }
      },
      {
        id: "glow-size",
        label: "光晕大小",
        hint: "直径；触屏设备看不到光晕属正常",
        min: 120, max: 800, step: 20, value: 340,
        fmt: function (v) { return v + "px"; },
        apply: function (v) {
          root.style.setProperty("--cursor-glow-size", v + "px");
        }
      }
    ];

    /* --canvas 是十六进制色，解析出 RGB 供「底色罩」合成用。
       这样色相跟着 tokens.css 走，面板自己不留第二份真相。 */
    function canvasRGB() {
      var c = getComputedStyle(root).getPropertyValue("--canvas").trim();
      var m = /^#([0-9a-fA-F]{6})$/.exec(c);
      if (m) {
        var n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      return [252, 252, 253];
    }

    var panel = document.createElement("div");
    panel.className = "tw-panel";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "主题调参面板");
    panel.hidden = true;
    panel.innerHTML =
      '<div class="tw-panel__head">' +
        '<p class="tw-panel__title">主题调参</p>' +
        '<button class="tw-panel__close" type="button" aria-label="关闭调参面板">✕</button>' +
      "</div>" +
      '<p class="tw-panel__note">拖动即时生效；只影响当前这次浏览，刷新即回到 CSS 默认值。</p>' +
      "<div class=\"tw-panel__rows\"></div>" +
      '<div class="tw-panel__foot">' +
        '<button class="btn btn--secondary btn--sm" type="button" data-tw="copy">复制参数</button>' +
        '<button class="btn btn--secondary btn--sm" type="button" data-tw="reset">重置</button>' +
        '<a class="btn btn--secondary btn--sm" href="index.html">回首页</a>' +
      "</div>";

    var rowsBox = panel.querySelector(".tw-panel__rows");
    var touched = [];      /* 面板改过的旋钮 id，重置时据此清掉内联样式 */

    CONTROLS.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "tw-row";

      var top = document.createElement("div");
      top.className = "tw-row__top";
      var label = document.createElement("span");
      label.className = "tw-row__label";
      label.textContent = c.label;
      var val = document.createElement("span");
      val.className = "tw-row__val";
      val.textContent = c.fmt(c.value);
      top.appendChild(label);
      top.appendChild(val);

      var input = document.createElement("input");
      input.type = "range";
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      input.value = String(c.value);
      input.setAttribute("aria-label", c.label);
      input.id = "tw-" + c.id;

      var hint = document.createElement("div");
      hint.className = "tw-row__hint";
      hint.textContent = c.hint;

      input.addEventListener("input", function () {
        var v = parseFloat(input.value);
        c.apply(v);
        val.textContent = c.fmt(v);
        pushTouched(c.id);
      });

      row.appendChild(top);
      row.appendChild(input);
      row.appendChild(hint);
      rowsBox.appendChild(row);
      c._input = input;
      c._val = val;
    });

    function pushTouched(id) {
      if (touched.indexOf(id) === -1) touched.push(id);
    }

    /* 复制当前参数：把面板改过的令牌导成一段可粘贴的 CSS，
       方便把满意的数值带回来固化进 tokens.css。 */
    var copyBtn = panel.querySelector('[data-tw="copy"]');
    copyBtn.addEventListener("click", function () {
      var lines = ["/* AIHub 主题调参 · 导出于 " + new Date().toLocaleString("zh-CN") + " */"];
      if (!touched.length) {
        lines.push("/* 还没有拖动过任何滑块 —— 全是 tokens.css 的默认值 */");
      }
      /* 直接读 :root 上的内联值，最准，且与 apply 的写法无关 */
      touched.forEach(function (id) {
        (PROP_NAMES[id] || []).forEach(function (n) {
          var v = root.style.getPropertyValue(n);
          if (v) lines.push(n + ": " + v.trim() + ";");
        });
      });
      var text = lines.join("\n");
      var done = function () {
        copyBtn.textContent = "已复制";
        window.setTimeout(function () { copyBtn.textContent = "复制参数"; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });

    /* 重置：把面板写过的内联样式逐个移除，令牌即回落到 tokens.css */
    panel.querySelector('[data-tw="reset"]').addEventListener("click", function () {
      touched.forEach(function (id) {
        (PROP_NAMES[id] || []).forEach(function (n) {
          root.style.removeProperty(n);
        });
      });
      touched = [];
      CONTROLS.forEach(function (c) {
        c._input.value = String(c.value);
        c._val.textContent = c.fmt(c.value);
      });
    });

    document.body.appendChild(panel);

    /* logo 点击 = 开关面板。
       ⚠ 这会顶掉 logo 原本「回首页」的行为 —— 导航里仍有「首页」链接，
         面板里也放了一个「回首页」按钮兜底。
         带修饰键的点击（Ctrl/Cmd/Shift）与中键仍然走原生跳转，不劫持。 */
    function toggle(open) {
      var next = arguments.length ? open : panel.hidden;
      panel.hidden = !next;
      brand.setAttribute("aria-expanded", next ? "true" : "false");
      if (next) panel.querySelector(".tw-panel__close").focus();
    }
    brand.setAttribute("aria-expanded", "false");
    brand.setAttribute("aria-controls", "tw-panel");
    brand.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      toggle();
    });
    panel.querySelector(".tw-panel__close").addEventListener("click", function () {
      toggle(false);
      brand.focus();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !panel.hidden) {
        toggle(false);
        brand.focus();
      }
    });
    document.addEventListener("pointerdown", function (e) {
      if (panel.hidden) return;
      if (panel.contains(e.target) || brand.contains(e.target)) return;
      toggle(false);
    });

    /* 无头截图用：URL 写成 #tw-panel 就直接展开（和钉帧探针一个套路）。
       ⚠ 刻意用「纯 id 形状」的片段，而不是 #panel=on ——
         非 id 形状的 hash 会让 FAQ 深链的 querySelector 抛异常（见第 9 节注释）。 */
    if (location.hash === "#tw-panel") toggle(true);
  }

  /* 每个旋钮驱动的令牌名，供「复制参数」与「重置」共用。
     放在 initTweakPanel 外面，避免每次打开面板都重建一份。 */
  var PROP_NAMES = {
    "hue": ["--hue-dur", "--aurora-dur-breath", "--aurora-dur-c"],
    "flow": ["--btn-flow-dur", "--grad-pan-dur", "--cta-flow-dur"],
    "band": ["--grad-band-btn", "--grad-band-text"],
    "veil": ["--page-veil"],
    "aurora": ["--aurora-strength"],
    "grain": ["--grain-opacity"],
    "glow": ["--cursor-glow-tint"],
    "glow-size": ["--cursor-glow-size"]
  };

  /* ---------- Init ---------- */
  function init() {
    initTypewriters();
    initCounters();
    initClock();
    initSpotlight();
    initCursorGlow();
    initTweakPanel();
    initFaqDeepLink();
    initFaqHashSync();
    onScroll();
  }
  window.addEventListener("scroll", onScroll, { passive: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
