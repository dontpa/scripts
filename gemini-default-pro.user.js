// ==UserScript==
// @name         Gemini 默认选择 Pro（新对话也生效）
// @namespace    https://example.com/
// @version      1.0.0
// @description  进入/新建对话时，自动把输入框的模式切到 Pro
// @match        https://gemini.google.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  /***************
   * 可调参数
   ***************/
  const TARGET_TEXT = "Pro";
  // 如果你的菜单里有 “Thinking with Pro/Pro Thinking” 之类，你不想选它，就排除：
  const EXCLUDE_TEXTS = ["Thinking"];
  // true: 每次检测到不是 Pro 都会强制切回；false: 每个会话 URL 仅“默认切一次”
  const FORCE_ALWAYS = false;
  // 调试开关
  const DEBUG = false;

  const log = (...args) =>
    DEBUG && console.log("[gemini-default-pro]", ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // SPA：用 URL 作为“会话/路由”key，新对话一般会变
  const state = {
    key: "",
    doneForKey: false,
    tries: 0,
    lastTryAt: 0,
  };

  function getRouteKey() {
    return location.pathname + location.search + location.hash;
  }

  function refreshRouteKey() {
    const k = getRouteKey();
    if (k !== state.key) {
      state.key = k;
      state.doneForKey = false;
      state.tries = 0;
      log("route changed:", k);
    }
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").trim();
  }

  // 输入框区域的模式切换按钮：button.input-area-switch
  // 你贴的结构里它在 data-test-id="bard-mode-menu-button" 下方出现
  function findModeButton() {
    return (
      document.querySelector(
        '[data-test-id="bard-mode-menu-button"] button.input-area-switch',
      ) ||
      document.querySelector("bard-mode-switcher button.input-area-switch") ||
      document.querySelector('button.input-area-switch[aria-haspopup="menu"]')
    );
  }

  // 当前模式文字：data-test-id="logo-pill-label-container" 里会有 Pro :contentReference[oaicite:2]{index=2}
  function currentModeLabel(btn) {
    const labelEl =
      btn.querySelector('[data-test-id="logo-pill-label-container"]') ||
      btn.querySelector(".input-area-switch-label");
    return textOf(labelEl) || textOf(btn);
  }

  function isTarget(label) {
    if (!label) return false;
    if (!label.includes(TARGET_TEXT)) return false;
    return !EXCLUDE_TEXTS.some((x) => label.includes(x));
  }

  // 弹出菜单：Angular Material overlay，面板 class 有 gds-mode-switch-menu
  function findProMenuItem() {
    const panels = Array.from(
      document.querySelectorAll(
        ".cdk-overlay-container .gds-mode-switch-menu, .cdk-overlay-container .mat-mdc-menu-panel",
      ),
    );

    for (const panel of panels) {
      const items = Array.from(
        panel.querySelectorAll(
          "button.mat-mdc-menu-item, [role='menuitem'], [role='option']",
        ),
      );
      for (const item of items) {
        const t = textOf(item);
        if (
          t.includes(TARGET_TEXT) &&
          !EXCLUDE_TEXTS.some((x) => t.includes(x))
        ) {
          return item;
        }
      }
    }
    return null;
  }

  function safeClick(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
    return true;
  }

  async function ensureProOnce() {
    refreshRouteKey();

    // 每个会话“默认切一次”，避免你在同一会话里手动选别的又被拉回
    if (!FORCE_ALWAYS && state.doneForKey) return;

    // 简单节流
    const now = Date.now();
    if (now - state.lastTryAt < 250) return;
    state.lastTryAt = now;

    const btn = findModeButton();
    if (!btn) {
      log("mode button not found");
      return;
    }

    const label = currentModeLabel(btn);
    if (isTarget(label)) {
      state.doneForKey = true;
      log("already Pro");
      return;
    }

    // 打开菜单
    safeClick(btn);
    await sleep(120);

    // 找到 Pro 选项并点击
    const proItem = findProMenuItem();
    if (!proItem) {
      log("Pro menu item not found (maybe not available in your account/UI)");
      return;
    }
    safeClick(proItem);

    // 再等一小会儿，让 UI 更新
    await sleep(120);

    // 反查确认
    const label2 = currentModeLabel(btn);
    if (isTarget(label2)) {
      state.doneForKey = true;
      log("switched to Pro");
    } else {
      log("switch attempt done, but label is:", label2);
    }

    state.tries++;
    // 防止极端情况下无限尝试（比如你的账号根本没有 Pro）
    if (state.tries > 80) state.doneForKey = true;
  }

  // 统一调度（避免 mutation 高频触发）
  let scheduled = false;
  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensureProOnce().catch((e) => log("ensureProOnce error:", e));
    });
  }

  // DOM 变化：输入框区域重建、新对话加载时会触发
  const mo = new MutationObserver(scheduleEnsure);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // SPA 路由：pushState/replaceState/popstate
  const _pushState = history.pushState;
  history.pushState = function (...args) {
    const ret = _pushState.apply(this, args);
    scheduleEnsure();
    return ret;
  };
  const _replaceState = history.replaceState;
  history.replaceState = function (...args) {
    const ret = _replaceState.apply(this, args);
    scheduleEnsure();
    return ret;
  };
  window.addEventListener("popstate", scheduleEnsure, true);

  // 初始多次尝试：兼容首屏异步渲染
  scheduleEnsure();
  setTimeout(scheduleEnsure, 800);
  setTimeout(scheduleEnsure, 2000);
})();
