/* Bifrost 控制台中文化脚本。
 * 由 nginx 注入到页面 <head>（见 nginx.conf 的 18082 端口），也可以当 Tampermonkey 用户脚本用。
 * 原理：按词典把页面里的英文文本节点和 placeholder/title/aria-label 替换成中文，
 * 用 MutationObserver 跟踪 React 的重新渲染；右下角按钮在「中文 / EN」之间切换，选择存在 localStorage。
 */
(function () {
  "use strict";
  var KEY = "bifrost-ui-lang";
  var DICT_URL = (window.__BIFROST_ZH_BASE__ || "/__zh/") + "dict.json";
  var ATTRS = ["placeholder", "title", "aria-label"];
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var dict = null;
  var lower = {}; // case-insensitive fallback ("PROVIDER SETUP" -> "Provider setup")
  var origText = new WeakMap(); // text node -> original English
  var origAttr = new WeakMap(); // element -> {attr: original}
  var lang = "zh";
  try { lang = localStorage.getItem(KEY) || "zh"; } catch (e) {}

  // Patterns for strings with numbers inside (exact dictionary can't match these).
  var PATTERNS = [
    [/^(\d[\d,]*) selected$/, "已选 $1 项"],
    [/^Showing (\d[\d,]*) (?:-|to) (\d[\d,]*) of (\d[\d,]*)(?: results| entries| logs)?$/, "第 $1-$2 条，共 $3 条"],
    [/^Page (\d+) of (\d+)$/, "第 $1 / $2 页"],
    [/^(\d+) of (\d+) steps? complete$/, "已完成 $1 / $2 步"],
    [/^(\d+) of (\d+)$/, "$1 / $2"],
    [/^(\d[\d,]*) results?$/, "$1 条结果"],
    [/^(\d[\d,]*) logs?$/, "$1 条日志"],
    [/^(\d[\d,]*) requests?$/, "$1 个请求"],
    [/^Last (\d+) (minutes?|hours?|days?)$/, function (m, n, u) { return "最近 " + n + " " + ({ minute: "分钟", minutes: "分钟", hour: "小时", hours: "小时", day: "天", days: "天" })[u]; }],
    [/^(\d+) (seconds?|minutes?|hours?|days?) ago$/, function (m, n, u) { return n + " " + ({ second: "秒", seconds: "秒", minute: "分钟", minutes: "分钟", hour: "小时", hours: "小时", day: "天", days: "天" })[u] + "前"; }],
  ];

  function tr(s) {
    if (!s) return null;
    var t = s.trim();
    if (!t || !/[A-Za-z]/.test(t)) return null;
    var hit = dict[t];
    if (hit === undefined) hit = lower[t.toLowerCase()];
    if (hit === undefined && /[:.…]$/.test(t)) {          // "Name:" -> "名称："
      var base = t.replace(/[:.…]+$/, "");
      if (dict[base] !== undefined) hit = dict[base] + (t.endsWith(":") ? "：" : t.slice(base.length));
    }
    if (hit === undefined) {
      for (var i = 0; i < PATTERNS.length; i++) {
        if (PATTERNS[i][0].test(t)) { hit = t.replace(PATTERNS[i][0], PATTERNS[i][1]); break; }
      }
    }
    if (hit === undefined) return null;
    return s.replace(t, hit); // keep surrounding whitespace
  }

  function skipped(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (SKIP[n.tagName] || n.isContentEditable || n.id === "bf-zh-toggle") return true;
      if (n.classList && (n.classList.contains("monaco-editor") || n.classList.contains("cm-editor"))) return true;
    }
    return false;
  }

  function doText(node) {
    if (!node.parentNode || skipped(node.parentNode)) return;
    var cur = node.nodeValue;
    var orig = origText.get(node);
    if (orig === undefined || (cur !== tr(orig) && cur !== orig)) { orig = cur; origText.set(node, orig); }
    var want = lang === "zh" ? (tr(orig) || orig) : orig;
    if (cur !== want) node.nodeValue = want;
  }

  function doAttrs(el) {
    if (skipped(el)) return;
    var store = origAttr.get(el) || {};
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i];
      if (!el.hasAttribute(a)) continue;
      var cur = el.getAttribute(a);
      var orig = store[a];
      if (orig === undefined || (cur !== tr(orig) && cur !== orig)) { orig = cur; store[a] = orig; }
      var want = lang === "zh" ? (tr(orig) || orig) : orig;
      if (cur !== want) el.setAttribute(a, want);
    }
    origAttr.set(el, store);
  }

  function walk(root) {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 11) return;
    if (root.nodeType === 1) doAttrs(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    var n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }

  var pending = new Set(), scheduled = false;
  function flush() {
    scheduled = false;
    observer.disconnect();
    pending.forEach(function (n) { if (n.isConnected) walk(n); });
    pending.clear();
    observe();
  }
  var observer = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === "childList") m.addedNodes.forEach(function (n) { pending.add(n); });
      else pending.add(m.target);
    }
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  });
  function observe() {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function toggleButton() {
    var b = document.createElement("button");
    b.id = "bf-zh-toggle";
    b.type = "button";
    b.title = "切换界面语言 / Switch language";
    b.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:6px 12px;border-radius:999px;" +
      "border:1px solid rgba(127,127,127,.35);background:rgba(24,24,27,.92);color:#fafafa;font:600 12px/1.4 system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    function label() { b.textContent = lang === "zh" ? "中文 → EN" : "EN → 中文"; }
    label();
    b.onclick = function () {
      lang = lang === "zh" ? "en" : "zh";
      try { localStorage.setItem(KEY, lang); } catch (e) {}
      document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
      label();
      observer.disconnect(); walk(document.body); observe();
    };
    document.body.appendChild(b);
  }

  function start(d) {
    dict = d;
    Object.keys(d).forEach(function (k) { var l = k.toLowerCase(); if (!(l in lower)) lower[l] = d[k]; });
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    walk(document.body);
    observe();
    toggleButton();
  }

  function boot() {
    if (window.__BIFROST_ZH_DICT__) return start(window.__BIFROST_ZH_DICT__);
    fetch(DICT_URL, { cache: "no-cache" }).then(function (r) { return r.json(); }).then(start)
      .catch(function (e) { console.warn("[bifrost-zh] 词典加载失败", e); });
  }
  if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
