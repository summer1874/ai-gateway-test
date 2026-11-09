/* 隐藏 Bifrost 开源版里只有企业版才能用的页面。
 * 页面清单是 2026-11-06 在 v2.4.0 上逐个打开菜单路由、检测 "enterprise license" 提示得到的（共 28 个）。
 * 做法：隐藏侧边栏里指向这些路由的子菜单；整组都是企业版的分组直接隐藏；直接访问这些地址会跳到日志页；
 * 侧边栏底部的「预约演示」销售卡片也一起隐藏。
 * 右下角「企业功能」按钮可以临时显示回来（存在 localStorage）。
 */
(function () {
  "use strict";
  var KEY = "bifrost-hide-enterprise";
  var FALLBACK = "/workspace/logs";
  var ENTERPRISE = [
    "/workspace/circuit-breaker",
    "/workspace/alerting",
    "/workspace/governance/org-chart",
    "/workspace/governance/users",
    "/workspace/governance/business-units",
    "/workspace/governance/rbac",
    "/workspace/governance/access-profiles",
    "/workspace/governance/projects",
    "/workspace/scim",
    "/workspace/audit-logs",
    "/workspace/guardrails",
    "/workspace/edge-control",
    "/workspace/cluster",
    "/workspace/adaptive-routing",
  ];
  // Sidebar groups whose every child is enterprise-only (labels in both languages, since zh-bifrost.js may have translated them).
  var GROUPS = ["Alerting", "告警", "Guardrails", "护栏", "Edge Control", "边缘控制", "Cluster", "集群", "Adaptive Routing", "自适应路由"];

  var hide = true;
  try { hide = localStorage.getItem(KEY) !== "0"; } catch (e) {}

  function isEnterprise(path) {
    for (var i = 0; i < ENTERPRISE.length; i++) {
      var p = ENTERPRISE[i];
      if (path === p || path.indexOf(p + "/") === 0) return true;
    }
    return false;
  }

  function setHidden(el, on) {
    if (!el) return;
    if (on) { if (el.style.display !== "none") { el.dataset.bfEntHidden = "1"; el.style.display = "none"; } }
    else if (el.dataset.bfEntHidden) { el.style.display = ""; delete el.dataset.bfEntHidden; }
  }

  function apply() {
    // 1) sub-menu links and any other in-app link pointing to an enterprise route
    document.querySelectorAll('a[href^="/workspace/"]').forEach(function (a) {
      var path = a.getAttribute("href").split("?")[0];
      if (!isEnterprise(path)) return;
      var item = a.closest('[data-sidebar="menu-sub-item"],[data-slot="sidebar-menu-sub-item"],[data-sidebar="menu-item"],[data-slot="sidebar-menu-item"]');
      setHidden(item || a, hide);
    });
    // 2) whole groups that only contain enterprise pages
    document.querySelectorAll('[data-sidebar="menu-button"],[data-slot="sidebar-menu-button"]').forEach(function (b) {
      if (b.tagName !== "BUTTON") return;
      var label = (b.innerText || "").trim().split("\n")[0].trim();
      if (GROUPS.indexOf(label) === -1) return;
      setHidden(b.closest('[data-sidebar="menu-item"],[data-slot="sidebar-menu-item"]') || b, hide);
    });
    // 3) sales cards ("Need help with production setup? Book a demo")
    document.querySelectorAll('a[href*="calendly.com"]').forEach(function (a) {
      setHidden(a.closest(".absolute") || a.closest('[class*="bg-card"]') || a, hide);
    });
    // 4) route guard
    if (hide && isEnterprise(location.pathname)) {
      history.replaceState(history.state, "", FALLBACK);
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    }
  }

  var scheduled = false;
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(function () { scheduled = false; apply(); }); } }

  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); schedule(); return r; };
  });
  addEventListener("popstate", schedule);

  function button() {
    var b = document.createElement("button");
    b.id = "bf-ent-toggle";
    b.type = "button";
    b.style.cssText = "position:fixed;right:118px;bottom:16px;z-index:2147483647;padding:6px 12px;border-radius:999px;" +
      "border:1px solid rgba(127,127,127,.35);background:rgba(24,24,27,.92);color:#fafafa;font:600 12px/1.4 system-ui,sans-serif;" +
      "cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    function label() { b.textContent = hide ? "企业功能：已隐藏" : "企业功能：显示中"; b.title = hide ? "点击显示企业版页面" : "点击隐藏企业版页面"; }
    label();
    b.onclick = function () {
      hide = !hide;
      try { localStorage.setItem(KEY, hide ? "1" : "0"); } catch (e) {}
      label(); apply();
    };
    document.body.appendChild(b);
  }

  function boot() {
    apply();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    button();
  }
  if (document.body) boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
