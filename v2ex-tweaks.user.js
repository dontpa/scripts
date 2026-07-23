// ==UserScript==
// @name         V2EX Tweaks
// @namespace    https://tampermonkey.net/
// @version      2.5.0
// @description  V2EX 日常增强：用户标签（本地存储 / 导入导出 / 智能合并）；回复嵌套树 + 合并分页；未读新回复标记 + j/k 跳转；高赞阅览室（图片 Lightbox）；Base64 解码（熵过滤）；折叠状态持久化；悬停引用预览；多页加载失败重试；每日签到；Imgur 代理。
// @author       you
// @match        https://v2ex.com/*
// @match        https://www.v2ex.com/*
// @match        https://edge.v2ex.com/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      v2ex.com
// @connect      www.v2ex.com
// @connect      edge.v2ex.com
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  // =========================
  // 0) 统一配置
  // =========================
  const CONFIG = {
    daily: {
      page: '/mission/daily',
      delayMinMs: 1500,
      delayMaxMs: 3800,
      requestTimeoutMs: 12000,
      verifyRetries: 3,
      verifyIntervalMs: 900,
      // 网络类错误的自动补签：失败后延迟重试，避免一次抖动就漏签
      networkRetries: 3,
      networkRetryDelayMs: 5 * 60 * 1000,
      // 页面长期打开时的兜底轮询：仅在"今日未签到"时才真正发请求
      pollIntervalMs: 15 * 60 * 1000,
      // V2EX 的每日奖励按服务器所在时区（UTC+8）跨天，不能用 UTC 日期判断
      timeZone: 'Asia/Shanghai',
      storeKey: 'v2ex_daily_check_ymd_v4',
      notify: true,
    },
    tags: {
      storeKey: 'v2ex_user_tags_v1',
      maxTagLength: 24,
      // 墓碑保留时长：超过该时长的删除记录在合并时被清理
      tombstoneTtlMs: 180 * 24 * 60 * 60 * 1000,
      exportVersion: 1,
    },
    b64: {
      minLen: 8,
      targetSelectors: ['.topic_content', '.reply_content'],
      excludeList: [
        'boss', 'bilibili', 'Bilibili', 'Encrypto', 'encrypto',
        'Window10', 'airpords', 'Windows7',
      ],
      // Shannon 熵阈值：低于此值的解码结果视为乱码/误判，直接跳过
      entropyThreshold: 3.0,
    },
    nav: {
      scrollOffsetRatio: 0.22,
    },
    threadTree: {
      collapseKeyPrefix: 'v2_collapse_',
      readKeyPrefix: 'v2_last_read_',
      pageFetchConcurrency: 4,
      pageFetchTimeoutMs: 15000,
    },
  };

  // =========================
  // 1) 通用小工具
  // =========================
  const log = (...args) => console.log('[V2EX-Enhance]', ...args);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function notify(title, text, timeout = 3500) {
    try { GM_notification({ title, text, timeout }); } catch (_) {}
  }

  // V2EX 服务端按 UTC+8 跨天，签到判重必须用同一时区，否则 16:00Z–24:00Z 这段
  // 时间里（北京时间次日 0–8 点）会误判为"今天已签到"而漏签。
  const YMD_FORMATTER = (() => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.daily.timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
    } catch (_) { return null; }
  })();

  function ymd(time = Date.now()) {
    if (YMD_FORMATTER) {
      // en-CA 固定输出 YYYY-MM-DD
      return YMD_FORMATTER.format(time);
    }
    return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function isTopicPage() {
    return /^\/t\/\d+(?:\/|$)/.test(location.pathname);
  }

  function debounce(fn, wait) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  // GM_* 在部分管理器（或 @grant 缺失时）不存在，统一降级到 localStorage
  const GM = {
    get(key, fallback) {
      try { return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; }
      catch (_) { return fallback; }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(key, value);
        else localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (err) { log('Storage write failed:', err); return false; }
    },
    onChange(key, handler) {
      try {
        if (typeof GM_addValueChangeListener === 'function') {
          GM_addValueChangeListener(key, (_k, _old, next, remote) => { if (remote) handler(next); });
          return;
        }
      } catch (_) {}
      window.addEventListener('storage', e => { if (e.key === key) handler(undefined); });
    },
    menu(label, handler) {
      try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, handler); } catch (_) {}
    },
  };

  // 把 hex 颜色转成 rgba，用于标签胶囊的底色/边框（避免依赖 color-mix 的浏览器支持）
  function hexToRgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(138, 148, 166, ${alpha})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  // Shannon 熵：衡量字符串的信息多样性
  // 低熵 = 字符分布单一，高概率是乱码或短英文单词误判
  function shannonEntropy(str) {
    if (!str.length) return 0;
    const freq = {};
    for (const c of str) freq[c] = (freq[c] || 0) + 1;
    const len = str.length;
    let h = 0;
    for (const count of Object.values(freq)) {
      const p = count / len;
      h -= p * Math.log2(p);
    }
    return h;
  }

  // =========================
  // 2) 样式（合并注入）
  // =========================

  // ── 全站样式：用户标签胶囊 / 编辑气泡 / 管理面板 / Toast ──
  GM_addStyle(`
    :root {
      --v2t-font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      --v2t-surface: #fff;
      --v2t-surface-2: #f7f8fa;
      --v2t-text: #2b2f38;
      --v2t-text-dim: #8a94a6;
      --v2t-border: #e6e9f0;
      --v2t-shadow: 0 12px 40px rgba(18, 24, 40, 0.16);
      /* 标签体系专用主色（紫）。刻意避开脚本里代表"系统状态"的蓝
         （NEW / 引用 / b64 / 新回复计数条），两者不该被看成同一类东西。 */
      --v2t-accent: #8b45c9;
      --v2t-accent-soft: rgba(139, 69, 201, 0.15);
    }
    #Wrapper.Night {
      --v2t-surface: #23252b;
      --v2t-surface-2: #2b2e35;
      --v2t-text: #dfe2e8;
      --v2t-text-dim: #8b93a3;
      --v2t-border: #3a3d45;
      --v2t-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
      --v2t-accent: #c084e8;
      --v2t-accent-soft: rgba(192, 132, 232, 0.2);
    }

    /* ── 胶囊 ──
       圆角药丸 + 前导圆点，形状上就区别于方形实心的 NEW 徽标 */
    .v2t-slot { display: inline-flex; align-items: center; gap: 4px; vertical-align: middle; margin-left: 6px; }
    .v2t-chip {
      display: inline-flex; align-items: center; max-width: 160px;
      padding: 0 8px 0 6px; height: 17px; line-height: 17px;
      font-size: 11px; font-weight: 600; font-family: var(--v2t-font);
      letter-spacing: 0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      border-radius: 9px; cursor: pointer; user-select: none;
      background: var(--v2t-chip-bg); color: var(--v2t-chip-fg);
      border: 1px solid var(--v2t-chip-bd);
      transition: filter 0.12s, transform 0.12s;
    }
    .v2t-chip::before {
      content: ''; flex: none;
      width: 4px; height: 4px; margin-right: 5px;
      border-radius: 50%; background: currentColor; opacity: 0.8;
    }
    .v2t-chip:hover { filter: brightness(0.94); }
    .v2t-chip:active { transform: scale(0.96); }
    #Wrapper.Night .v2t-chip {
      background: var(--v2t-chip-bg-n); color: var(--v2t-chip-fg-n); border-color: var(--v2t-chip-bd-n);
    }
    /* 未打标签时的 + 按钮平时完全隐藏（且不可点击），仅在该行悬停/聚焦时浮现 */
    .v2t-add {
      display: inline-flex; align-items: center; justify-content: center;
      width: 15px; height: 15px; border-radius: 4px;
      font-size: 12px; line-height: 1; font-family: var(--v2t-font);
      color: var(--v2t-text-dim); border: 1px dashed var(--v2t-border);
      cursor: pointer; user-select: none; opacity: 0; pointer-events: none;
      transition: opacity 0.15s, color 0.15s, border-color 0.15s;
    }
    .v2t-add:focus-visible,
    .cell:hover .v2t-add, .hot-card:hover .v2t-add, .header:hover .v2t-add { opacity: 1; pointer-events: auto; }
    .v2t-add:hover { color: var(--v2t-accent); border-color: var(--v2t-accent); }

    /* ── 编辑气泡 ── */
    #v2t-editor {
      position: fixed; z-index: 100001; width: 268px;
      background: var(--v2t-surface); color: var(--v2t-text);
      border: 1px solid var(--v2t-border); border-radius: 10px;
      box-shadow: var(--v2t-shadow); padding: 12px;
      font-family: var(--v2t-font); font-size: 13px;
      opacity: 0; pointer-events: none; transform: translateY(6px) scale(0.98);
      transition: opacity 0.14s ease, transform 0.14s ease;
    }
    #v2t-editor.visible { opacity: 1; pointer-events: auto; transform: none; }
    #v2t-editor .v2t-ed-head {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 10px; font-size: 12px; color: var(--v2t-text-dim);
    }
    #v2t-editor .v2t-ed-head img { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; flex: none; }
    #v2t-editor .v2t-ed-head b { color: var(--v2t-text); font-size: 13px; font-weight: 600; }
    #v2t-editor input[type="text"] {
      width: 100%; box-sizing: border-box; height: 30px; padding: 0 9px;
      border: 1px solid var(--v2t-border); border-radius: 6px;
      background: var(--v2t-surface-2); color: var(--v2t-text);
      font-size: 13px; font-family: inherit; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    #v2t-editor input[type="text"]:focus {
      border-color: var(--v2t-accent);
      box-shadow: 0 0 0 3px var(--v2t-accent-soft);
    }
    /* 配色默认收起：常规流程是"输入 → 回车"，不必先挑颜色 */
    #v2t-editor .v2t-color-toggle {
      display: inline-flex; align-items: center; gap: 5px; margin-top: 10px;
      font-size: 11px; color: var(--v2t-text-dim); cursor: pointer; user-select: none;
    }
    #v2t-editor .v2t-color-toggle:hover { color: var(--v2t-accent); }
    #v2t-editor .v2t-color-toggle .v2t-color-preview {
      width: 10px; height: 10px; border-radius: 50%; flex: none;
    }
    #v2t-editor .v2t-swatches { display: none; gap: 6px; margin: 8px 0 2px; }
    #v2t-editor .v2t-swatches.open { display: flex; }
    #v2t-editor .v2t-swatch {
      width: 20px; height: 20px; border-radius: 50%; cursor: pointer;
      border: 2px solid transparent; background-clip: padding-box;
      transition: transform 0.12s;
    }
    #v2t-editor .v2t-swatch:hover { transform: scale(1.12); }
    #v2t-editor .v2t-swatch.selected { box-shadow: 0 0 0 2px var(--v2t-surface), 0 0 0 4px currentColor; }
    #v2t-editor .v2t-recent { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
    #v2t-editor .v2t-recent-item {
      font-size: 11px; padding: 1px 7px; border-radius: 4px; cursor: pointer;
      background: var(--v2t-surface-2); color: var(--v2t-text-dim);
      border: 1px solid var(--v2t-border); max-width: 110px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #v2t-editor .v2t-recent-item:hover { color: var(--v2t-accent); border-color: var(--v2t-accent); }
    #v2t-editor .v2t-ed-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    #v2t-editor .v2t-ed-actions .v2t-spacer { margin-left: auto; }

    .v2t-btn {
      height: 27px; padding: 0 12px; border-radius: 6px;
      border: 1px solid var(--v2t-border); background: var(--v2t-surface);
      color: var(--v2t-text); font-size: 12px; font-family: var(--v2t-font);
      cursor: pointer; transition: background 0.15s, border-color 0.15s, color 0.15s;
    }
    .v2t-btn:hover { background: var(--v2t-surface-2); }
    .v2t-btn:disabled { opacity: 0.5; cursor: default; }
    .v2t-btn.primary { background: var(--v2t-accent); border-color: var(--v2t-accent); color: #fff; }
    .v2t-btn.primary:hover { filter: brightness(1.06); background: var(--v2t-accent); }
    .v2t-btn.danger { color: #e0483a; }
    .v2t-btn.danger:hover { background: rgba(224, 72, 58, 0.08); border-color: rgba(224, 72, 58, 0.4); }

    /* ── 管理面板 ── */
    #v2t-manager {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(20, 24, 34, 0.42); backdrop-filter: blur(2px);
      display: flex; align-items: center; justify-content: center;
      opacity: 0; visibility: hidden; transition: opacity 0.18s, visibility 0.18s;
      font-family: var(--v2t-font);
    }
    #v2t-manager.active { opacity: 1; visibility: visible; }
    #v2t-manager .v2t-panel {
      width: min(680px, 92vw); max-height: min(76vh, 720px);
      display: flex; flex-direction: column;
      background: var(--v2t-surface); color: var(--v2t-text);
      border-radius: 14px; box-shadow: var(--v2t-shadow);
      transform: translateY(10px) scale(0.99); transition: transform 0.18s ease;
      overflow: hidden;
    }
    #v2t-manager.active .v2t-panel { transform: none; }
    #v2t-manager .v2t-panel-head {
      display: flex; align-items: center; gap: 10px;
      padding: 14px 16px; border-bottom: 1px solid var(--v2t-border);
    }
    #v2t-manager .v2t-title { font-size: 15px; font-weight: 600; }
    #v2t-manager .v2t-count { font-size: 12px; color: var(--v2t-text-dim); }
    #v2t-manager .v2t-search {
      margin-left: auto; width: 170px; height: 28px; padding: 0 10px;
      border: 1px solid var(--v2t-border); border-radius: 6px;
      background: var(--v2t-surface-2); color: var(--v2t-text);
      font-size: 12px; font-family: inherit; outline: none;
    }
    #v2t-manager .v2t-search:focus { border-color: var(--v2t-accent); }
    #v2t-manager .v2t-list { overflow-y: auto; flex: 1; padding: 4px 0; }
    #v2t-manager .v2t-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 16px; border-bottom: 1px solid var(--v2t-border);
    }
    #v2t-manager .v2t-row:last-child { border-bottom: none; }
    #v2t-manager .v2t-row:hover { background: var(--v2t-surface-2); }
    #v2t-manager .v2t-row a.v2t-user { color: var(--v2t-text); font-size: 13px; text-decoration: none; font-weight: 500; }
    #v2t-manager .v2t-row a.v2t-user:hover { color: var(--v2t-accent); }
    #v2t-manager .v2t-row .v2t-time { margin-left: auto; font-size: 11px; color: var(--v2t-text-dim); font-variant-numeric: tabular-nums; }
    #v2t-manager .v2t-row .v2t-row-act {
      font-size: 11px; color: var(--v2t-text-dim); cursor: pointer; padding: 2px 4px; border-radius: 4px;
    }
    #v2t-manager .v2t-row .v2t-row-act:hover { color: var(--v2t-accent); background: var(--v2t-surface); }
    #v2t-manager .v2t-row .v2t-row-act.danger:hover { color: #e0483a; }
    #v2t-manager .v2t-empty { padding: 48px 16px; text-align: center; color: var(--v2t-text-dim); font-size: 13px; }
    #v2t-manager .v2t-panel-foot {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 16px; border-top: 1px solid var(--v2t-border);
      background: var(--v2t-surface-2);
    }
    #v2t-manager .v2t-panel-foot .v2t-spacer { margin-left: auto; }
    #v2t-manager .v2t-merge {
      padding: 12px 16px; border-top: 1px solid var(--v2t-border);
      background: var(--v2t-surface-2); font-size: 12px; line-height: 1.7;
    }
    #v2t-manager .v2t-merge b { color: var(--v2t-accent); font-variant-numeric: tabular-nums; }
    #v2t-manager .v2t-merge .v2t-merge-opts { display: flex; flex-wrap: wrap; gap: 12px; margin: 8px 0 10px; }
    #v2t-manager .v2t-merge label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: var(--v2t-text); }

    /* ── Toast ── */
    #v2t-toast {
      position: fixed; left: 50%; bottom: 32px; z-index: 100002;
      transform: translate(-50%, 10px); opacity: 0; pointer-events: none;
      padding: 8px 16px; border-radius: 20px;
      background: rgba(22, 27, 46, 0.92); color: #eef2ff;
      font-size: 12.5px; font-family: var(--v2t-font);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #v2t-toast.visible { opacity: 1; transform: translate(-50%, 0); }

    #v2t-entry {
      display: inline-block; margin-left: 8px;
      padding: 2px 10px; background-color: #f0f2f5; color: #ccc;
      border-radius: 12px; font-size: 12px; cursor: pointer;
      transition: all 0.2s ease; line-height: 1.5; border: 1px solid transparent;
    }
    #v2t-entry:hover { background-color: #e3e8f0; color: #555; border-color: #ccc; }
    #Wrapper.Night #v2t-entry { background-color: #2b2e35; color: #6a707c; }
    #Wrapper.Night #v2t-entry:hover { background-color: #343841; color: #b9bfca; border-color: #4a4e58; }
  `);

  if (isTopicPage()) GM_addStyle(`
    /* ===== 楼层树 ===== */
    :root {
      --indent-width: 16px;
      --line-color: #ebebeb;
      --line-hover: #a8beff;
      --bg-hover: #fafbff;
      --new-accent: #4a7af0;
      --new-accent-soft: rgba(74, 122, 240, 0.08);
      --bg-new: #edf2ff;
    }

    .box { padding-bottom: 0 !important; }

    .reply-children {
      margin-left: var(--indent-width);
      border-left: 2px solid var(--line-color);
      transition: border-color 0.2s, opacity 0.2s;
      position: relative;
    }
    .reply-children.is-collapsed { display: none; }

    /* cursor:auto 保留浏览器默认行为（文字上 I 型，空白处箭头）
       只在左侧 20px 伪元素上设 pointer，与 JS 的 rect.left > 20 判断对齐 */
    .reply-children.collapsible { cursor: auto; }
    .reply-children.collapsible::before {
      content: '';
      position: absolute;
      left: -2px;
      top: 0; bottom: 0;
      width: 20px;
      cursor: pointer;
    }
    .reply-children.collapsible:hover { border-left-color: var(--line-hover); }
    .reply-children .reply-children { pointer-events: auto; }

    .reply-collapsed-hint {
      display: none;
      font-size: 11px; color: #999;
      padding: 3px 8px 3px calc(var(--indent-width) + 4px);
      cursor: pointer; user-select: none;
      transition: color 0.15s;
    }
    .reply-collapsed-hint:hover { color: var(--new-accent); }
    .reply-children.is-collapsed + .reply-collapsed-hint { display: block; }

    .reply-wrapper .cell {
      padding: 6px 8px !important;
      border-bottom: 1px solid #f5f5f5 !important;
      background: transparent;
      transition: background 0.12s;
    }
    .reply-wrapper > .cell:hover { background-color: var(--bg-hover); }
    .reply-wrapper .avatar {
      display: block;
      width: 100% !important; min-width: 0 !important; max-width: 100% !important;
      height: auto !important; min-height: 0 !important; max-height: none !important;
      aspect-ratio: 1 / 1; object-fit: cover; flex: none;
      max-inline-size: 100% !important;
      border-radius: 4px; margin: 0 auto;
    }
    .reply_content { font-size: 14px; line-height: 1.5; margin-top: 2px; }
    .ago, .no, .fade { font-size: 11px !important; }

    /* ===== 回复头部：定宽身份列 + 紧随其后的元信息 =====
       身份列（用户名 + 标签）宽度固定，NEW 贴在这一列的右边缘，
       于是不管用户名多长，NEW 和时间都从同一条竖直基线开始。
       楼层块 .fr 用 margin-left:auto 顶到最右，它内部宽度多少都不影响左侧的列。 */
    .v2-reply-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    /* 列宽由 JS 按本帖最长的"用户名 + 标签"实测得出（--rh-id-w），
       既不截断用户名，也不会留下一大片空白 */
    .v2-reply-head .rh-id {
      display: flex; align-items: center; gap: 4px;
      flex: 0 0 var(--rh-id-w, 170px); max-width: 46%; min-width: 0;
    }
    /* 测量态：临时解除约束，让 JS 读到未被压缩的自然宽度 */
    .rh-measuring .v2-reply-head .rh-id {
      flex: 0 0 auto !important; width: max-content !important; max-width: none !important;
    }
    .v2-reply-head .rh-id > strong {
      display: inline-flex; align-items: center;
      flex: 0 1 auto; min-width: 0;
    }
    /* 只让用户名本身省略号截断，标签胶囊永远完整显示 */
    .v2-reply-head .rh-id > strong > a {
      min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .v2-reply-head .rh-id .v2t-slot { flex: 0 0 auto; }
    /* 头部里的胶囊收窄一些，避免一个超长标签把整列撑开 */
    .v2-reply-head .rh-id .v2t-chip { max-width: 104px; }
    /* NEW 右对齐到身份列末尾：已读行这里为空但列宽不变，时间不会左右横跳 */
    .v2-reply-head .rh-new { flex: 0 0 auto; margin-left: auto; padding-left: 6px; }
    .v2-reply-head .rh-new .new-badge { margin-left: 0; }
    .v2-reply-head .rh-meta {
      display: flex; align-items: center; gap: 8px;
      flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden;
    }
    .v2-reply-head > .fr {
      float: none !important;
      display: inline-flex; align-items: center;
      flex: 0 0 auto; margin: 0 0 0 auto !important;
    }

    .reply-new > .cell {
      background: linear-gradient(90deg, rgba(74,122,240,0.10) 0%, rgba(74,122,240,0.04) 50%, transparent 100%) !important;
      border-left: 3px solid #4a7af0 !important;
      padding-left: 5px !important;
      animation: new-reply-flash 0.6s ease-out;
    }
    @keyframes new-reply-flash {
      0%   { background-color: rgba(74,122,240,0.18); }
      100% { background-color: transparent; }
    }
    /* NEW 是"这条回复的状态"，不是"这个人的属性"：
       方角 + 实心蓝，和圆角描边的紫色标签胶囊在形状与颜色上都拉开距离；
       位置也跟在时间戳后面，归入回复元信息一组，而不是贴着用户名。 */
    .new-badge {
      display: inline-block;
      font-size: 9px; font-weight: 700;
      color: var(--new-accent); background: var(--new-accent-soft);
      border-radius: 2px;
      padding: 0 4px; line-height: 13px; height: 13px;
      margin-left: 6px;
      vertical-align: middle; letter-spacing: 0.6px;
      position: relative; top: -1px;
    }

    #v2ex-new-count-bar {
      padding: 6px 12px;
      background: linear-gradient(90deg, #eef2ff 0%, #f8f9ff 100%);
      border-bottom: 1px solid #dde5ff;
      border-radius: 4px 4px 0 0;
      font-size: 12px; color: #6680cc;
      display: flex; align-items: center; gap: 6px;
      user-select: none;
    }
    #v2ex-new-count-bar .ncb-dot { width:6px; height:6px; background:var(--new-accent); border-radius:50%; flex-shrink:0; }
    #v2ex-new-count-bar strong { color: var(--new-accent); font-weight: 700; }
    #v2ex-new-count-bar .ncb-hint { margin-left: auto; opacity: 0.5; font-size: 11px; }

    #v2ex-loading-bar {
      padding: 8px; background: #fff;
      text-align: center; border-bottom: 1px solid #eee;
      font-size: 12px; color: #999;
    }
    .cell[style*="text-align: center"], #bottom-pagination, a[name="last_page"] { display: none; }

    /* ── 多页加载失败重试横幅 ── */
    #v2ex-retry-banner {
      padding: 8px 14px;
      background: #fff8e6; border-bottom: 1px solid #ffe0a0;
      border-radius: 4px 4px 0 0;
      font-size: 12px; color: #a06000;
      display: flex; align-items: center; gap: 10px;
    }
    #v2ex-retry-banner button {
      padding: 2px 10px;
      border: 1px solid #f0b030; border-radius: 4px;
      background: #fff; color: #a06000;
      cursor: pointer; font-size: 12px;
      transition: background 0.15s;
    }
    #v2ex-retry-banner button:hover { background: #fff8e6; }
    #v2ex-retry-banner button:disabled { opacity: 0.5; cursor: default; }

    /* ===== j/k 导航 HUD ===== */
    #v2ex-nav-hud {
      position: fixed; bottom: 28px; right: 28px; z-index: 99998;
      display: flex; align-items: center; gap: 6px;
      padding: 6px 14px 6px 10px;
      background: rgba(22,27,46,0.90); color: #dde4ff;
      border-radius: 20px; font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.3px; backdrop-filter: blur(8px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06);
      pointer-events: none; opacity: 0;
      transform: translateY(8px) scale(0.97);
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #v2ex-nav-hud.visible { opacity: 1; transform: translateY(0) scale(1); }
    #v2ex-nav-hud .hud-arrow { font-size: 13px; opacity: 0.7; }
    #v2ex-nav-hud .hud-label { font-size: 10px; font-weight: 700; letter-spacing: 1px; color: #7fa8ff; opacity: 0.8; }
    #v2ex-nav-hud .hud-count { font-weight: 600; color: #c5d5ff; font-variant-numeric: tabular-nums; }
    #v2ex-nav-hud .hud-sep { opacity: 0.2; }
    #v2ex-nav-hud .hud-hint { opacity: 0.35; font-size: 11px; font-family: monospace; }
    .reply-nav-active > .cell { outline: 2px solid rgba(74,122,240,0.50) !important; outline-offset: -2px; transition: outline 0.15s ease; }

    /* ===== Base64 解码 ===== */
    .v2-b64-wrap {
      word-break: break-all;
      position: relative;
      display: inline;
    }
    .v2-b64-link { color: #4a7af0 !important; text-decoration: none; }
    .v2-b64-link:hover { color: #3060d8 !important; text-decoration: underline; }
    .v2-b64-plain {
      background: rgba(74, 122, 240, 0.08);
      border-radius: 3px;
      padding: 0 3px;
      color: #3a5ab8;
      cursor: default;
    }
    .v2-b64-plain:hover { background: rgba(74, 122, 240, 0.14); }
    .v2-b64-mark {
      display: inline-block;
      font-size: 9px; font-weight: 700; font-style: normal;
      color: #8aa8f8; border: 1px solid #d0defe; border-radius: 2px;
      padding: 0 3px; line-height: 13px;
      vertical-align: middle; position: relative; top: -1px;
      margin-right: 4px; cursor: default; user-select: none;
      text-decoration: none !important; letter-spacing: 0.2px;
    }
    .v2-b64-actions {
      display: none;
      position: absolute;
      top: -22px;
      right: 0;
      align-items: center;
      background: #fff;
      border: 1px solid #c8d8ff;
      border-radius: 4px;
      overflow: hidden;
      box-shadow: 0 1px 6px rgba(74,122,240,0.13);
      z-index: 10;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .v2-b64-action {
      font-size: 10px;
      padding: 1px 7px;
      color: #4a7af0;
      cursor: pointer;
      white-space: nowrap;
      line-height: 17px;
      user-select: none;
    }
    .v2-b64-action + .v2-b64-action { border-left: 1px solid #dbe5ff; }
    .v2-b64-wrap:hover .v2-b64-actions { display: inline-flex; }
    .v2-b64-action:hover { background: #eef2ff; }
    .v2-b64-action.copied { color: #52c41a; }

    /* ===== 悬停引用预览 ===== */
    #v2ex-ref-preview {
      position: fixed; z-index: 99997;
      background: #fff;
      border: 1px solid #e4e8f0; border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.12);
      padding: 10px 14px; max-width: 360px;
      font-size: 13px; line-height: 1.5;
      pointer-events: none;
      opacity: 0; transform: translateY(4px);
      transition: opacity 0.15s, transform 0.15s;
    }
    #v2ex-ref-preview.visible { opacity: 1; transform: translateY(0); }
    .rp-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 12px; }
    .rp-avatar { width: 16px; height: 16px; border-radius: 3px; object-fit: cover; flex: none; }
    .rp-name { font-weight: 600; color: #444; }
    .rp-floor { color: #aaa; font-size: 11px; }
    .rp-content {
      color: #333; max-height: 120px; overflow: hidden;
      -webkit-mask-image: linear-gradient(180deg, #000 70%, transparent 100%);
      mask-image: linear-gradient(180deg, #000 70%, transparent 100%);
    }
    .v2-ref-link {
      color: var(--new-accent);
      text-decoration: underline; text-decoration-style: dotted;
      text-underline-offset: 2px; cursor: pointer;
    }

    /* ===== Lightbox ===== */
    #v2ex-lightbox {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.85); z-index: 999999;
      display: flex; align-items: center; justify-content: center;
      cursor: zoom-out; opacity: 0; visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
    }
    #v2ex-lightbox.active { opacity: 1; visibility: visible; }
    #v2ex-lightbox img {
      max-width: 92vw; max-height: 92vh;
      object-fit: contain; border-radius: 4px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.5);
      pointer-events: none;
    }

    /* ===== 高赞阅览室 ===== */
    #v2ex-hot-btn {
      display: inline-block; margin-left: 10px;
      padding: 2px 10px; background-color: #f0f2f5; color: #ccc;
      border-radius: 12px; font-size: 12px; cursor: pointer;
      transition: all 0.2s ease; line-height: 1.5;
      border: 1px solid transparent;
    }
    #v2ex-hot-btn:hover { background-color: #e3e8f0; color: #555; border-color: #ccc; }

    #hot-overlay {
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(240,242,245,0.95); z-index: 99999;
      display: flex; justify-content: center; align-items: flex-start;
      overflow-y: scroll; opacity: 0; visibility: hidden;
      transition: opacity 0.15s ease;
    }
    #hot-overlay.active { opacity: 1; visibility: visible; }
    .hot-container {
      width: 92%; max-width: 1000px;
      margin: 30px auto 80px auto;
      background: #fff; border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.08);
      overflow: hidden; padding: 0;
    }
    .hot-card {
      background: #fff; padding: 14px 24px;
      border-bottom: 1px solid #f0f0f0;
      display: flex; flex-direction: column;
      transition: background 0.1s;
    }
    .hot-card:last-child { border-bottom: none; }
    .hot-card:hover { background: #fafafa; }
    .rank-1 { border-left: 3px solid #faad14; background: linear-gradient(90deg, #fffdf5 0%, #fff 100%); }
    .rank-2 { border-left: 3px solid #ccc; }
    .rank-3 { border-left: 3px solid #d48806; }
    .card-header-row { display: flex; align-items: center; margin-bottom: 6px; font-size: 12px; }
    .user-avatar {
      display: block;
      width: 18px; min-width: 18px; max-width: 18px;
      height: 18px; min-height: 18px; max-height: 18px;
      aspect-ratio: 1 / 1; object-fit: cover; flex: none;
      max-inline-size: none; border-radius: 3px; margin-right: 8px;
    }
    .user-name { font-weight: 600; color: #444; text-decoration: none; margin-right: 8px; }
    .floor-tag {
      background: #f5f5f5; color: #aaa; padding: 0 5px; border-radius: 3px;
      margin-right: 10px; cursor: pointer; font-size: 11px; height: 18px; line-height: 18px;
    }
    .floor-tag:hover { background: #e6f7ff; color: #1890ff; }
    .time-tag { color: #ddd; margin-right: auto; transform: scale(0.9); transform-origin: left; }
    .likes-pill { font-size: 12px; font-weight: 600; padding: 0 6px; }
    .rank-1 .likes-pill { color: #faad14; }
    .rank-normal .likes-pill { color: #ff6b6b; opacity: 0.8; }
    .card-content { font-size: 14px; line-height: 1.6; color: #222; word-wrap: break-word; padding-left: 26px; }
    .card-content p { margin: 0 0 5px 0; }
    .card-content img { max-width: 100%; max-height: 350px; border-radius: 4px; margin: 5px 0; display: block; cursor: zoom-in; }
    .card-content pre { padding: 10px; background: #f8f8f8; border: 1px solid #eee; border-radius: 3px; font-size: 12px; margin: 8px 0; }
    #hot-overlay::-webkit-scrollbar { width: 4px; }
    #hot-overlay::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }

    /* ===== 夜间模式适配 ===== */
    #Wrapper.Night {
      --line-color: #3a3d45;
      --line-hover: #4c6bb5;
      --bg-hover: #2a2d34;
      --new-accent: #6f97ff;
      --bg-new: #23304d;
    }
    #Wrapper.Night .reply-wrapper .cell { border-bottom-color: #303239 !important; }
    #Wrapper.Night .reply-collapsed-hint { color: #7b818c; }
    #Wrapper.Night #v2ex-new-count-bar {
      background: linear-gradient(90deg, #262b3a 0%, #23252b 100%);
      border-bottom-color: #343a4d; color: #93a6d8;
    }
    #Wrapper.Night #v2ex-loading-bar { background: #23252b; border-bottom-color: #303239; color: #7b818c; }
    #Wrapper.Night #v2ex-retry-banner { background: #33291a; border-bottom-color: #5a4520; color: #e0b25e; }
    #Wrapper.Night #v2ex-retry-banner button { background: #2a2d34; border-color: #5a4520; color: #e0b25e; }
    #Wrapper.Night #v2ex-ref-preview { background: #23252b; border-color: #3a3d45; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    #Wrapper.Night .rp-name { color: #dfe2e8; }
    #Wrapper.Night .rp-content { color: #c2c7d0; }
    #Wrapper.Night .v2-b64-plain { background: rgba(111,151,255,0.14); color: #9fb8ff; }
    #Wrapper.Night .v2-b64-actions { background: #23252b; border-color: #3a4a6d; }
    #Wrapper.Night .v2-b64-action { color: #8fabff; }
    #Wrapper.Night .v2-b64-action:hover { background: #2c3346; }
    #Wrapper.Night #v2ex-hot-btn { background-color: #2b2e35; color: #6a707c; }
    #Wrapper.Night #v2ex-hot-btn:hover { background-color: #343841; color: #b9bfca; border-color: #4a4e58; }
    #Wrapper.Night #hot-overlay { background: rgba(16,18,22,0.94); }
    #Wrapper.Night .hot-container { background: #23252b; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    #Wrapper.Night .hot-card { background: #23252b; border-bottom-color: #303239; }
    #Wrapper.Night .hot-card:hover { background: #2a2d34; }
    #Wrapper.Night .rank-1 { background: linear-gradient(90deg, #2e2a1d 0%, #23252b 100%); }
    #Wrapper.Night .user-name { color: #dfe2e8; }
    #Wrapper.Night .card-content { color: #d3d7de; }
    #Wrapper.Night .card-content pre { background: #1c1e23; border-color: #303239; }
    #Wrapper.Night .floor-tag { background: #2b2e35; color: #7b818c; }
  `);

  // =========================
  // 3) 功能A：每日自动签到
  // =========================
  const Daily = (() => {
    const CLAIMED_RE = /每日登录奖励已(?:领取|发放)|今天的登录奖励已经领取过了(?:哦)?|今天已经领取|已成功领取每日登录奖励|成功领取每日登录奖励|奖励已发放/i;
    // 已领取的任务页会展示连续登录天数，且不再渲染领取按钮
    const CONSECUTIVE_RE = /已连续登录\s*\d+\s*天/;
    const REJECTED_RE = /浏览器有一些奇奇怪怪的设置|请用一个干净安装的浏览器重试/i;

    // 网络抖动/限流属于可重试错误，与"页面结构变了""登录失效"区分开，
    // 避免一次超时就弹一个失败通知并放弃当天签到。
    class RetryableError extends Error {}

    let inFlight = null;
    let retryTimer = 0;
    let networkFailures = 0;

    function requestText(url, referer) {
      const target = new URL(url, location.origin);
      if (target.origin !== location.origin) return Promise.reject(new Error('拒绝跨站签到请求'));
      const headers = { Accept: 'text/html,application/xhtml+xml' };
      // V2EX 的领取接口会校验来源页，缺少 Referer 时请求会被判为异常来源而不发放奖励。
      if (referer) {
        try { headers.Referer = new URL(referer, location.origin).href; } catch (_) {}
      }
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: target.href,
          responseType: 'text',
          timeout: CONFIG.daily.requestTimeoutMs,
          headers,
          onload: response => {
            if (response.status < 200 || response.status >= 400) {
              reject(new RetryableError(`HTTP ${response.status} for ${target.pathname}`));
              return;
            }
            resolve({
              text: typeof response.responseText === 'string'
                ? response.responseText
                : (typeof response.response === 'string' ? response.response : ''),
              finalUrl: response.finalUrl || target.href,
            });
          },
          ontimeout: () => reject(new RetryableError(`请求超时：${target.pathname}`)),
          onerror: () => reject(new RetryableError(`请求失败：${target.pathname}`)),
          onabort: () => reject(new RetryableError(`请求已取消：${target.pathname}`)),
        });
      });
    }
    function parseHtml(html) { return new DOMParser().parseFromString(html, 'text/html'); }

    function pageText(doc) {
      return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function isSignedOut(doc, finalUrl = location.href) {
      let finalPath = '';
      try { finalPath = new URL(finalUrl, location.origin).pathname; } catch (_) {}
      if (finalPath.startsWith('/signin')) return true;
      const signin = doc.querySelector('#Top a[href^="/signin"], form[action^="/signin"]');
      const member = doc.querySelector('#Top a[href^="/member/"], #Top a[onclick*="/signout?once="]');
      return !!signin && !member;
    }

    function alreadyRedeemed(doc) {
      if (doc.querySelector('#Main .fa-ok-sign')) return true;
      const text = pageText(doc);
      if (CLAIMED_RE.test(text)) return true;
      // 兜底：任务页已渲染连续登录天数却没有领取入口 → 今日已领取
      return CONSECUTIVE_RE.test(text) && !findRedeemUrl(doc);
    }

    function findRedeemUrl(doc) {
      const selectors = [
        'a[href*="/mission/daily/redeem"]',
        'form[action*="/mission/daily/redeem"]',
        '[onclick*="/mission/daily/redeem"]',
      ];
      for (const el of doc.querySelectorAll(selectors.join(','))) {
        const source = [el.getAttribute('href'), el.getAttribute('action'), el.getAttribute('onclick')]
          .filter(Boolean).join(' ');
        const match = source.match(/\/mission\/daily\/redeem\?[^'"<>\s)]*\bonce=([A-Za-z0-9_-]+)/i);
        if (match?.[1]) return `/mission/daily/redeem?once=${encodeURIComponent(match[1])}`;
      }

      // 兼容领取地址被放在内联脚本或转义 HTML 中的旧版页面。
      const match = (doc.documentElement?.innerHTML || '')
        .replaceAll('&amp;', '&')
        .match(/\/mission\/daily\/redeem\?[^'"<>\s)]*\bonce=([A-Za-z0-9_-]+)/i);
      if (match?.[1]) return `/mission/daily/redeem?once=${encodeURIComponent(match[1])}`;
      return null;
    }

    async function loadPage(url, referer) {
      const response = await requestText(url, referer);
      const doc = parseHtml(response.text);
      return { ...response, doc };
    }

    function validateRedeemUrl(redeemUrl) {
      const target = new URL(redeemUrl, location.origin);
      if (target.origin !== location.origin || target.pathname !== '/mission/daily/redeem' || !target.searchParams.get('once')) {
        throw new Error('领取地址无效');
      }
      return target;
    }

    async function verifyClaimed(page, retries, intervalMs) {
      let lastStatus = 'unknown';
      for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) await sleep(intervalMs);
        const result = await loadPage(page, location.href);
        if (isSignedOut(result.doc, result.finalUrl)) return { status: 'signed-out', result };
        if (REJECTED_RE.test(pageText(result.doc))) return { status: 'rejected', result };
        if (alreadyRedeemed(result.doc)) return { status: 'claimed', result };
        lastStatus = findRedeemUrl(result.doc) ? 'claimable' : 'unknown';
      }
      return { status: lastStatus };
    }

    async function execute() {
      const {
        page, delayMinMs, delayMaxMs, storeKey,
        verifyRetries, verifyIntervalMs,
      } = CONFIG.daily;
      const today = ymd();
      if (GM.get(storeKey, '') === today) return 'already-done';
      if (isSignedOut(document, location.href)) return 'signed-out';

      const lockKey = `${storeKey}_lock`;
      const lock = GM.get(lockKey, null);
      // 跨标签页互斥：5 分钟内已有实例在跑就让路（也兼容进程被杀导致的锁残留）
      if (lock?.date === today && Date.now() - lock.startedAt < 5 * 60 * 1000) return 'locked';

      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      GM.set(lockKey, { date: today, startedAt: Date.now(), token });

      try {
        await sleep(randInt(delayMinMs, delayMaxMs));
        // 等待期间可能已被其它标签页完成
        if (GM.get(storeKey, '') === today) return 'already-done';

        const daily = await loadPage(page, location.href);
        if (isSignedOut(daily.doc, daily.finalUrl)) return 'signed-out';
        if (REJECTED_RE.test(pageText(daily.doc))) throw new Error('V2EX 拒绝了当前浏览器环境');

        if (alreadyRedeemed(daily.doc)) {
          GM.set(storeKey, today);
          return 'already-claimed';
        }

        const redeemUrl = findRedeemUrl(daily.doc);
        if (!redeemUrl) throw new Error('未找到领取按钮（页面结构可能已变更）');

        const target = validateRedeemUrl(redeemUrl);
        // 领取请求必须带上任务页作为 Referer
        const redeem = await loadPage(target.href, page);
        if (isSignedOut(redeem.doc, redeem.finalUrl)) throw new Error('登录状态已失效');
        if (REJECTED_RE.test(pageText(redeem.doc))) throw new Error('V2EX 拒绝了当前浏览器环境');

        // 领取后 V2EX 通常跳转到 /balance，页面本身不含"已领取"字样，
        // 因此需要回到任务页确认，而不是把跳转当作失败。
        let confirmed = alreadyRedeemed(redeem.doc);
        if (!confirmed) {
          const verification = await verifyClaimed(page, verifyRetries, verifyIntervalMs);
          if (verification.status === 'signed-out') throw new Error('登录状态已失效');
          if (verification.status === 'rejected') throw new Error('V2EX 拒绝了当前浏览器环境');
          confirmed = verification.status === 'claimed';
        }

        if (!confirmed) throw new RetryableError('领取请求已发送，但服务端未确认成功');

        GM.set(storeKey, today);
        return 'claimed';
      } finally {
        if (GM.get(lockKey, null)?.token === token) GM.set(lockKey, null);
      }
    }

    function run() {
      if (inFlight) return inFlight;
      inFlight = execute().then(status => {
        networkFailures = 0;
        if (status === 'claimed') {
          log('签到：领取成功');
          if (CONFIG.daily.notify) notify('V2EX 签到', '领取成功 ✅');
        } else if (status === 'already-claimed') {
          // 已在别处领取过：只记日志，不打扰用户
          log('签到：今日奖励已领取');
        } else if (status === 'signed-out') {
          log('签到：账号未登录，已跳过');
        }
        return status;
      }).catch(err => {
        const { networkRetries, networkRetryDelayMs, notify: doNotify } = CONFIG.daily;
        if (err instanceof RetryableError && networkFailures < networkRetries) {
          networkFailures++;
          log(`签到暂时失败（第 ${networkFailures}/${networkRetries} 次），稍后重试：`, err);
          clearTimeout(retryTimer);
          retryTimer = setTimeout(run, networkRetryDelayMs);
          return 'retrying';
        }
        networkFailures = 0;
        log('签到失败：', err);
        if (doNotify) notify('V2EX 签到', `失败：${err?.message || err}`);
        return 'failed';
      }).finally(() => { inFlight = null; });
      return inFlight;
    }

    function boot() {
      const tick = () => { if (GM.get(CONFIG.daily.storeKey, '') !== ymd()) run(); };
      const start = () => setTimeout(tick, 800);
      if (document.readyState === 'complete') start();
      else window.addEventListener('load', start, { once: true });

      // 长期打开的页面靠轮询跨天补签；后台标签页恢复可见时立刻补一次。
      // 轮询本身零成本：当天已签到时 tick 不会发出任何请求。
      setInterval(tick, CONFIG.daily.pollIntervalMs);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    }
    return { boot, run };
  })();

  // =========================
  // 4) 功能B：Base64 解码（含 Shannon 熵过滤）
  // =========================
  const B64 = (() => {
    const BASE64_RE = /[A-Za-z0-9+/]{8,}={0,2}/g;
    const VALID_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    const TARGET_SELECTOR = CONFIG.b64.targetSelectors.join(',');
    const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

    function tryDecode(text) {
      const { minLen, excludeList, entropyThreshold } = CONFIG.b64;
      if (text.length <= minLen) return null;
      if (excludeList.includes(text)) return null;
      if (!VALID_BASE64_RE.test(text)) return null;
      try {
        const binary = window.atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const d = UTF8_DECODER.decode(bytes);
        if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(d)) return null;
        // 熵过滤：排除低熵解码（乱码、单调重复字符等误判）
        if (shannonEntropy(d) < entropyThreshold) return null;
        return d;
      } catch (_) { return null; }
    }
    function makeReplacement(raw, decoded) {
      const wrap = document.createElement('span');
      wrap.className = 'v2-b64-wrap';
      if (/^https?:\/\//i.test(decoded)) {
        let href;
        try {
          const u = new URL(decoded);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
          href = u.href;
        } catch (_) { return null; }
        const a = document.createElement('a');
        a.className = 'v2-b64-link';
        a.href = href; a.target = '_blank'; a.rel = 'noreferrer noopener';
        a.title = href; a.textContent = decoded;
        wrap.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.className = 'v2-b64-plain';
        span.textContent = decoded;
        wrap.appendChild(span);
      }
      const mark = document.createElement('span');
      mark.className = 'v2-b64-mark'; mark.textContent = 'b64';
      mark.title = `decoded from base64\n${raw}`;
      wrap.prepend(mark);

      function createCopyAction(label, copiedLabel, clipboardText, title) {
        const btn = document.createElement('span');
        btn.className = 'v2-b64-action';
        btn.textContent = label;
        btn.title = title;
        btn.dataset.label = label;
        btn.dataset.copiedLabel = copiedLabel;
        btn.dataset.clipboardText = clipboardText;
        return btn;
      }

      // copy 是主动作：复制当前展示的解码结果；raw 才复制原始 base64。
      const actions = document.createElement('span');
      actions.className = 'v2-b64-actions';
      actions.appendChild(createCopyAction('copy', 'copied', decoded, '复制解码后的内容'));
      actions.appendChild(createCopyAction('raw', 'copied', raw, '复制原始 base64'));
      wrap.appendChild(actions);

      return wrap;
    }

    function processTextNode(node) {
      if (!node?.isConnected || !node.nodeValue || node.nodeValue.length <= CONFIG.b64.minLen) return;
      const parent = node.parentElement;
      if (!parent || parent.closest('.v2-b64-wrap, .v2-ref-link, a, script, style, textarea')) return;

      const text = node.nodeValue;
      let last = 0;
      const frag = document.createDocumentFragment();
      let changed = false;
      BASE64_RE.lastIndex = 0;
      let match;
      while ((match = BASE64_RE.exec(text)) !== null) {
        const candidate = match[0];
        const decoded = tryDecode(candidate);
        if (!decoded) continue;
        const replacement = makeReplacement(candidate, decoded);
        if (!replacement) continue;
        changed = true;
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
        frag.appendChild(replacement);
        last = match.index + candidate.length;
      }
      if (!changed || !node.parentNode) return;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }

    function processSubtree(root) {
      if (!root) return;
      if (root.nodeType === Node.TEXT_NODE) {
        processTextNode(root);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE || root.closest('.v2-b64-wrap, .v2-ref-link')) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || node.nodeValue.length <= CONFIG.b64.minLen) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          if (p.closest('.v2-b64-wrap, .v2-ref-link, a, script, style, textarea')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(processTextNode);
    }

    function processContent(contentEl) {
      if (!contentEl || contentEl.dataset.v2b64scanned === '1') return;
      processSubtree(contentEl);
      contentEl.dataset.v2b64scanned = '1';
    }

    function scanAll() {
      document.querySelectorAll(TARGET_SELECTOR).forEach(processContent);
    }

    function processAddedNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.parentElement?.closest(TARGET_SELECTOR)?.dataset.v2b64scanned === '1') processTextNode(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      if (node.matches(TARGET_SELECTOR)) processContent(node);
      node.querySelectorAll(TARGET_SELECTOR).forEach(processContent);

      const owner = node.closest(TARGET_SELECTOR);
      if (owner?.dataset.v2b64scanned === '1' && node !== owner) processSubtree(node);
    }

    function boot() {
      if (!isTopicPage()) return;
      scanAll();
      const root = document.querySelector('#Main') || document.body;
      document.addEventListener('click', e => {
        const btn = e.target.closest?.('.v2-b64-action');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        try { GM_setClipboard(btn.dataset.clipboardText || ''); } catch (err) { log('Clipboard error:', err); return; }
        btn.textContent = btn.dataset.copiedLabel;
        btn.classList.add('copied');
        clearTimeout(btn._v2CopyTimer);
        btn._v2CopyTimer = setTimeout(() => {
          if (!btn.isConnected) return;
          btn.textContent = btn.dataset.label;
          btn.classList.remove('copied');
        }, 1200);
      });
      new MutationObserver(mutations => {
        for (const mut of mutations) {
          for (const node of mut.addedNodes) processAddedNode(node);
        }
      }).observe(root, { childList: true, subtree: true });
    }
    return { boot };
  })();

  // =========================
  // 5) 功能C：楼层树 + 多页 + 折叠持久化 + 悬停引用预览
  // =========================
  const ThreadTree = (() => {

    // ── 解析单条回复 ──
    function parseReplyCell(cell, idx) {
      if (!cell?.id?.startsWith('r_')) return null;
      const replyId   = cell.id.replace('r_', '');
      const contentEl = cell.querySelector('.reply_content');
      const authorEl  = cell.querySelector('strong a');
      const floorEl   = cell.querySelector('.no');
      const avatarEl  = cell.querySelector('img.avatar');
      if (!contentEl || !authorEl || !floorEl) return null;

      const memberName = (authorEl.textContent || '').trim();
      const content    = contentEl.textContent || '';
      const floor      = (floorEl.textContent || '').trim();
      const floorNum   = Number(floor.match(/\d+/)?.[0]);
      if (!Number.isSafeInteger(floorNum)) return null;
      const likesText  = cell.querySelector('span.small')?.textContent || '';
      const likes      = Number(likesText.match(/\d+/)?.[0] || 0);
      const refMemberNames = [...content.matchAll(/@([a-zA-Z0-9_-]+)/g)].map(([, n]) => n);
      const refFloors      = [...content.matchAll(/#(\d+)/g)].map(([, f]) => f);

      return {
        element: cell, id: replyId, index: idx,
        memberName, memberLink: authorEl.href, memberAvatar: avatarEl?.src || '',
        content, floor, floorNum, likes,
        refMemberNames: refMemberNames.length ? refMemberNames : undefined,
        refFloors:      refFloors.length      ? refFloors      : undefined,
        children: [],
      };
    }

    function extractRepliesFromDoc(doc) {
      return Array.from(doc.querySelectorAll('div.cell[id^="r_"]'))
        .map((cell, idx) => parseReplyCell(cell, idx))
        .filter(Boolean);
    }

    // ── Map 构建，O(n)，供 inferParent 和 hoverPreview 共用 ──
    function buildLookupMaps(allReplies) {
      const floorMap = new Map();
      const nameMap  = new Map();
      for (const r of allReplies) {
        floorMap.set(r.floorNum, r);
        const key = r.memberName.toLowerCase();
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key).push(r);
      }
      return { floorMap, nameMap };
    }

    function findPreviousCandidate(candidates, index) {
      if (!candidates?.length) return null;
      let low = 0;
      let high = candidates.length - 1;
      let best = null;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const candidate = candidates[middle];
        if (candidate.index < index) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return best;
    }

    // ── 父节点推断，Map 查找 + 同名候选二分搜索 ──
    function inferParent(reply, { floorMap, nameMap }) {
      const { refMemberNames, refFloors, index, floorNum } = reply;
      const firstRefFloor = refFloors?.[0] ? Number(refFloors[0]) : null;
      if (firstRefFloor !== null && firstRefFloor < floorNum) {
        const exact = floorMap.get(firstRefFloor);
        if (exact && (!refMemberNames?.length || exact.memberName.toLowerCase() === refMemberNames[0].toLowerCase())) {
          return exact;
        }
      }
      if (!refMemberNames?.length) return null;

      const targetName = refMemberNames[0].toLowerCase();
      const candidates = nameMap.get(targetName);
      const candidate = findPreviousCandidate(candidates, index);
      return candidate?.floorNum < floorNum ? candidate : null;
    }

    // ── 折叠持久化（sessionStorage）──
    function collapseKey(topicId)    { return `${CONFIG.threadTree.collapseKeyPrefix}${topicId}`; }
    function getCollapsedSet(topicId) {
      try { return new Set(JSON.parse(sessionStorage.getItem(collapseKey(topicId)) || '[]')); }
      catch { return new Set(); }
    }
    function saveCollapsedSet(topicId, set) {
      try { sessionStorage.setItem(collapseKey(topicId), JSON.stringify([...set])); }
      catch (err) { log('Collapse state error:', err); }
    }

    // j/k 或锚点跳转可能落在被折叠的子树里，滚动过去会看到"空白"。
    // 先展开沿途所有折叠祖先，并同步持久化状态。
    function revealAncestors(el) {
      if (!el) return;
      const collapsed = [];
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (node.classList?.contains('reply-children') && node.classList.contains('is-collapsed')) {
          collapsed.push(node);
        }
      }
      if (!collapsed.length) return;
      const state = collapsed[collapsed.length - 1].closest('.box')?._v2CollapseState;
      for (const node of collapsed) {
        node.classList.remove('is-collapsed');
        state?.collapsedSet.delete(node.dataset.replyId);
      }
      if (state) saveCollapsedSet(state.topicId, state.collapsedSet);
    }

    // ── 头部重排 ──
    // V2EX 原始结构是一串行内节点（楼层浮动在右，用户名/时间/♥ 顺序排开），
    // 用户名长度不同就会让时间和 NEW 各排各的。这里把它整理成一个 flex 行：
    // [用户名 + 标签 ……… NEW]  [时间 ♥]  ——顶到最右—— [楼层]
    //  └─ 定宽身份列 ─┘
    // 身份列定宽，所以 NEW 和时间的起点在每一行都一样。
    // 结构不符合预期时直接返回，保持 V2EX 原样，不做半吊子改动。
    function layoutReplyHeader(cell) {
      const strong = cell.querySelector('strong');
      const container = strong?.parentElement;
      if (!container || container.querySelector(':scope > .v2-reply-head')) return;
      const content = container.querySelector(':scope > .reply_content');
      if (!content) return;

      // 收集 strong 到正文之间的头部节点（.sep5 之前）
      const nodes = [];
      for (let node = strong; node && node !== content; node = node.nextSibling) {
        if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('sep5')) break;
        nodes.push(node);
      }
      if (!nodes.length) return;

      const head = document.createElement('div');
      head.className = 'v2-reply-head';
      const identity = document.createElement('span');
      identity.className = 'rh-id';
      const meta = document.createElement('span');
      meta.className = 'rh-meta';
      const newSlot = document.createElement('span');
      newSlot.className = 'rh-new';

      const likes = [];
      const times = [];
      const badges = [];
      for (const node of nodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          // 原来的 &nbsp; 间隔交给 flex gap，非空文本保留在左侧
          if (node.nodeValue.trim()) identity.appendChild(node);
          else node.remove();
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }
        const cls = node.classList;
        if (cls.contains('ago')) times.push(node);
        else if (cls.contains('new-badge')) badges.push(node);
        else if (cls.contains('small') && cls.contains('fade')) likes.push(node);
        else identity.appendChild(node);   // strong / badges / 未知元素一律留在左侧
      }

      // 时间在前、♥ 在后，保持 V2EX 原本的阅读顺序
      meta.append(...times, ...likes);
      newSlot.append(...badges);
      // NEW 槽位放在身份列末尾，靠 margin-left:auto 贴到该列右边缘
      identity.appendChild(newSlot);
      head.append(identity, meta);

      const floor = container.querySelector(':scope > .fr');
      if (floor) head.appendChild(floor);

      container.insertBefore(head, container.querySelector(':scope > .sep5') || content);
    }

    // 按本帖实际内容确定身份列宽度：取最长的"用户名 + 标签"，夹在合理区间内。
    // 用固定值的话，短名字会留下一片空白，长名字又会被省略号截断——而用户名不该被截断。
    // 测量在 a 上取 scrollWidth（不受 ellipsis 影响），胶囊 flex 不收缩所以 offsetWidth 即真实宽度。
    function syncIdentityColumn(container) {
      const ids = container.querySelectorAll('.v2-reply-head > .rh-id');
      if (!ids.length) return;
      // 加测量态临时解除列宽约束，直接读每行的自然宽度——
      // 这样 gap / margin / NEW 徽标都被算进去了，不用手工凑常数。
      container.classList.add('rh-measuring');
      let widest = 0;
      for (const id of ids) {
        const width = id.getBoundingClientRect().width;
        if (width > widest) widest = width;
      }
      container.classList.remove('rh-measuring');
      if (!widest) return;
      container.style.setProperty('--rh-id-w', `${Math.min(Math.max(Math.ceil(widest), 120), 300)}px`);
    }

    // ── 渲染树 ──
    function renderTree(flatReplies, maps, container, topicId) {
      const roots = [];
      flatReplies.forEach(r => { r.children = []; });
      flatReplies.forEach(r => {
        const parent = inferParent(r, maps);
        if (parent) parent.children.push(r);
        else roots.push(r);
      });

      const collapsedSet = getCollapsedSet(topicId);
      const fragment     = document.createDocumentFragment();

      container._v2CollapseState = { topicId, collapsedSet };
      if (!container._v2CollapseBound) {
        container._v2CollapseBound = true;
        container.addEventListener('click', e => {
          const state = container._v2CollapseState;
          if (!state) return;

          const clickedHint = e.target.closest?.('.reply-collapsed-hint');
          let childrenEl = null;
          let hint = null;

          if (clickedHint && container.contains(clickedHint)) {
            hint = clickedHint;
            childrenEl = hint.previousElementSibling;
          } else {
            const clickedRail = e.target.closest?.('.reply-children.collapsible');
            if (!clickedRail || !container.contains(clickedRail)) return;
            const rect = clickedRail.getBoundingClientRect();
            if (e.clientX - rect.left > 20) return;
            childrenEl = clickedRail;
            hint = childrenEl.nextElementSibling;
          }

          if (!childrenEl?.classList.contains('reply-children') || !hint?.classList.contains('reply-collapsed-hint')) return;
          e.preventDefault();
          e.stopPropagation();

          const replyId = childrenEl.dataset.replyId;
          const nowCollapsed = childrenEl.classList.toggle('is-collapsed');
          if (nowCollapsed) state.collapsedSet.add(replyId);
          else state.collapsedSet.delete(replyId);
          saveCollapsedSet(state.topicId, state.collapsedSet);
          hint.textContent = `▶ 展开 ${childrenEl.dataset.replyCount} 条回复`;
        });
      }

      function appendNode(reply, parentEl) {
        const wrapper = document.createElement('div');
        wrapper.className = 'reply-wrapper';
        wrapper.dataset.replyId = reply.id;
        reply.element.classList.remove('inner');
        layoutReplyHeader(reply.element);
        wrapper.appendChild(reply.element);

        if (reply.children.length > 0) {
          const count      = reply.children.length;
          const childrenEl = document.createElement('div');
          childrenEl.className = 'reply-children collapsible';
          childrenEl.dataset.replyId = reply.id;
          childrenEl.dataset.replyCount = String(count);
          reply.children.forEach(child => appendNode(child, childrenEl));

          const hint = document.createElement('div');
          hint.className = 'reply-collapsed-hint';
          hint.textContent = `▶ 展开 ${count} 条回复`;

          // 恢复折叠状态
          if (collapsedSet.has(reply.id)) childrenEl.classList.add('is-collapsed');

          wrapper.appendChild(childrenEl);
          wrapper.appendChild(hint);
        }
        parentEl.appendChild(wrapper);
      }

      roots.forEach(r => appendNode(r, fragment));
      container.innerHTML = '';
      container.appendChild(fragment);
    }

    // ── 未读标记：仅在所有分页成功后推进阅读进度 ──
    function createReadState(topicId) {
      const key = `${CONFIG.threadTree.readKeyPrefix}${topicId}`;
      try {
        const stored = localStorage.getItem(key);
        return { key, firstVisit: stored === null, lastReadFloor: Number.parseInt(stored || '0', 10) || 0 };
      } catch (err) {
        log('Read state error:', err);
        return { key, firstVisit: true, lastReadFloor: 0, disabled: true };
      }
    }

    function markUnread(state, replies) {
      if (state.firstVisit) return 0;
      let newCount = 0;
      for (const r of replies) {
        if (r.floorNum <= state.lastReadFloor) continue;
        newCount++;
        r.element.classList.add('reply-new');
        if (r.element.querySelector('.new-badge')) continue;
        const badge = document.createElement('span');
        badge.className = 'new-badge'; badge.textContent = 'NEW'; badge.title = '未读新回复';
        // 头部已重排时放进预留槽位（对齐成一列）；
        // 否则退回到时间戳后面，跟回复元信息待在一起
        const slot = r.element.querySelector('.rh-new');
        if (slot) { slot.appendChild(badge); continue; }
        const anchor = r.element.querySelector('.ago') || r.element.querySelector('strong');
        anchor?.insertAdjacentElement('afterend', badge);
      }
      return newCount;
    }

    function commitReadState(state, replies) {
      if (state.disabled) return;
      let maxFloor = 0;
      for (const r of replies) if (r.floorNum > maxFloor) maxFloor = r.floorNum;
      try { localStorage.setItem(state.key, String(maxFloor)); }
      catch (err) { log('Read state error:', err); }
    }

    function updateNewCountBar(replyBox, newCount) {
      let bar = document.getElementById('v2ex-new-count-bar');
      if (newCount <= 0) {
        bar?.remove();
        return;
      }
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'v2ex-new-count-bar';
        replyBox.parentNode.insertBefore(bar, replyBox);
      }
      bar.innerHTML = `<span class="ncb-dot"></span><span>有 <strong>${newCount}</strong> 条新回复</span><span class="ncb-hint">j / k 键跳转</span>`;
    }

    // ── 悬停引用预览（在 B64 完成后运行，延迟 150ms）──
    function initHoverPreview(allReplies, { floorMap, nameMap }) {
      // 非全局：用于 acceptNode 内的测试（无 lastIndex 副作用）
      const REF_TEST_RE = /@[a-zA-Z0-9_-]+|#\d+/;
      // 全局：用于 exec 循环
      const REF_EXEC_RE = /(@[a-zA-Z0-9_-]+|#\d+)/g;

      let card      = null;
      let hideTimer = null;

      function getCard() {
        if (!card?.isConnected) {
          card = document.getElementById('v2ex-ref-preview');
        }
        if (!card) {
          card = document.createElement('div');
          card.id = 'v2ex-ref-preview';
          document.body.appendChild(card);
        }
        return card;
      }

      function showCard(refReply, anchorEl) {
        clearTimeout(hideTimer);
        const c = getCard();
        const header = document.createElement('div');
        header.className = 'rp-header';
        if (refReply.memberAvatar) {
          const avatar = document.createElement('img');
          avatar.className = 'rp-avatar';
          avatar.src = refReply.memberAvatar;
          avatar.alt = '';
          header.appendChild(avatar);
        }
        const name = document.createElement('span');
        name.className = 'rp-name';
        name.textContent = refReply.memberName;
        const floor = document.createElement('span');
        floor.className = 'rp-floor';
        floor.textContent = refReply.floor.startsWith('#') ? refReply.floor : `#${refReply.floor}`;
        header.append(name, floor);

        const content = document.createElement('div');
        content.className = 'rp-content';
        const source = refReply.element.querySelector('.reply_content');
        if (source) content.append(...source.cloneNode(true).childNodes);
        else content.textContent = refReply.content;
        c.replaceChildren(header, content);

        const rect  = anchorEl.getBoundingClientRect();
        const cardRect = c.getBoundingClientRect();
        const cardW = Math.min(360, cardRect.width || 360);
        const cardH = cardRect.height || 160;
        const left  = Math.max(4, Math.min(rect.left, window.innerWidth - cardW - 10));
        const top   = (window.innerHeight - rect.bottom > cardH + 10)
          ? rect.bottom + 6
          : Math.max(4, rect.top - cardH - 6);
        c.style.left = `${left}px`;
        c.style.top  = `${top}px`;
        c.classList.add('visible');
      }

      function hideCard() {
        hideTimer = setTimeout(() => card?.classList.remove('visible'), 120);
      }

      function findPreviousReplyByName(name, replyIndex) {
        const candidates = nameMap.get(name.toLowerCase());
        return findPreviousCandidate(candidates, replyIndex);
      }

      function bindPreview(anchor, refReply) {
        anchor.classList.add('v2-ref-link');
        anchor._v2RefReply = refReply;
        if (document._v2RefPreviewBound) return;
        document._v2RefPreviewBound = true;
        document.addEventListener('mouseover', e => {
          const target = e.target.closest?.('.v2-ref-link');
          if (!target?._v2RefReply || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) return;
          showCard(target._v2RefReply, target);
        });
        document.addEventListener('mouseout', e => {
          const target = e.target.closest?.('.v2-ref-link');
          if (!target?._v2RefReply || (e.relatedTarget instanceof Node && target.contains(e.relatedTarget))) return;
          hideCard();
        });
      }

      for (const reply of allReplies) {
        const contentEl = reply.element.querySelector('.reply_content');
        if (!contentEl) continue;

        // V2EX 会把 @ 与用户名拆成相邻文本和链接，直接绑定现有会员链接。
        contentEl.querySelectorAll('a[href^="/member/"]:not(.v2-ref-link)').forEach(anchor => {
          const previous = anchor.previousSibling;
          if (previous?.nodeType !== Node.TEXT_NODE || !/@\s*$/.test(previous.nodeValue || '')) return;
          const refReply = findPreviousReplyByName(anchor.textContent?.trim() || '', reply.index);
          if (refReply) bindPreview(anchor, refReply);
        });

        const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
            if (node.parentElement?.closest('.v2-b64-wrap, .v2-ref-link')) return NodeFilter.FILTER_REJECT;
            if (!REF_TEST_RE.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        });

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        nodes.forEach(node => {
          const text = node.nodeValue;
          const frag = document.createDocumentFragment();
          let last = 0, changed = false;
          REF_EXEC_RE.lastIndex = 0;
          let m;

          while ((m = REF_EXEC_RE.exec(text)) !== null) {
            const token = m[0];
            let refReply = null;

            if (token.startsWith('@')) {
              refReply = findPreviousReplyByName(token.slice(1), reply.index);
            } else if (token.startsWith('#')) {
              const floor = parseInt(token.slice(1), 10);
              const found = floorMap.get(floor) ?? null;
              refReply = (found && found.floorNum < reply.floorNum) ? found : null;
            }

            frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            if (refReply) {
              const span = document.createElement('span');
              span.className = 'v2-ref-link'; span.textContent = token;
              bindPreview(span, refReply);
              frag.appendChild(span);
              changed = true;
            } else {
              frag.appendChild(document.createTextNode(token));
            }
            last = m.index + token.length;
          }

          if (changed && node.parentNode) {
            frag.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(frag, node);
          }
        });
      }
    }

    function getTotalPages() {
      const candidates = [1];
      const max = Number.parseInt(document.querySelector('.page_input')?.getAttribute('max') || '', 10);
      if (Number.isSafeInteger(max)) candidates.push(max);
      document.querySelectorAll('a.page_normal, .page_current').forEach(el => {
        const fromText = Number.parseInt(el.textContent || '', 10);
        if (Number.isSafeInteger(fromText)) candidates.push(fromText);
        try {
          const fromUrl = Number.parseInt(new URL(el.href, location.href).searchParams.get('p') || '', 10);
          if (Number.isSafeInteger(fromUrl)) candidates.push(fromUrl);
        } catch (_) {}
      });
      return Math.max(...candidates);
    }

    function pageUrl(page) {
      const url = new URL(location.href);
      url.searchParams.set('p', String(page));
      url.hash = '';
      return url.href;
    }

    async function fetchReplyPage(page) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.threadTree.pageFetchTimeoutMs);
      try {
        const res = await fetch(pageUrl(page), {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
        const replies = extractRepliesFromDoc(doc);
        if (!replies.length) throw new Error('页面中没有回复');
        return replies;
      } finally {
        clearTimeout(timer);
      }
    }

    async function fetchPages(pages, onProgress) {
      if (!pages.length) return [];
      const results = new Array(pages.length);
      let cursor = 0;
      let completed = 0;
      const worker = async () => {
        while (cursor < pages.length) {
          const index = cursor++;
          const page = pages[index];
          try {
            results[index] = { page, replies: await fetchReplyPage(page) };
          } catch (error) {
            results[index] = { page, replies: null, error };
          } finally {
            completed++;
            onProgress?.(completed, pages.length);
          }
        }
      };
      const workerCount = Math.min(CONFIG.threadTree.pageFetchConcurrency, pages.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      return results;
    }

    // 个别页失败多半是并发触发的限流，静默重试一次再打扰用户。
    // 全军覆没则更可能是断网/掉登录，直接交给横幅让用户决定，避免再空等一轮超时。
    async function fetchPagesWithRetry(pages, onProgress) {
      const results = await fetchPages(pages, onProgress);
      const failedIndexes = results
        .map((result, index) => (result.replies ? -1 : index))
        .filter(index => index >= 0);
      if (!failedIndexes.length || failedIndexes.length === results.length) return results;

      await sleep(600);
      const retried = await fetchPages(failedIndexes.map(index => results[index].page));
      failedIndexes.forEach((resultIndex, i) => {
        if (retried[i]?.replies) results[resultIndex] = retried[i];
      });
      return results;
    }

    function normalizeReplies(replies) {
      const byId = new Map();
      for (const reply of replies) {
        if (!byId.has(reply.id)) byId.set(reply.id, reply);
      }
      const normalized = [...byId.values()].sort((a, b) => a.floorNum - b.floorNum);
      normalized.forEach((reply, index) => { reply.index = index; });
      return normalized;
    }

    // ── 主流程 ──
    async function init() {
      if (!isTopicPage()) return;
      const topicId = location.pathname.match(/\/t\/(\d+)/)?.[1];
      if (!topicId) return;

      const replyBox = Array.from(document.querySelectorAll('.box')).find(b => b.querySelector('div[id^="r_"]'));
      if (!replyBox) return;

      const loadingBar = document.createElement('div');
      loadingBar.id = 'v2ex-loading-bar'; loadingBar.textContent = '加载中…';
      replyBox.parentNode.insertBefore(loadingBar, replyBox);

      const totalPages = getTotalPages();
      let allReplies = extractRepliesFromDoc(document);
      const requestedPage = Number.parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
      const currentPage = Number.isSafeInteger(requestedPage) && requestedPage >= 1 && requestedPage <= totalPages
        ? requestedPage
        : 1;
      const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(page => page !== currentPage);
      const pageResults = await fetchPagesWithRetry(pages, (completed, total) => {
        loadingBar.textContent = `加载回复页 ${completed} / ${total}…`;
      });

      const failedPages = pageResults.filter(result => !result.replies).map(result => result.page);
      for (const result of pageResults) {
        if (result.replies) allReplies.push(...result.replies);
        else log(`Reply page ${result.page} failed:`, result.error);
      }

      allReplies = normalizeReplies(allReplies);
      document.querySelectorAll('.page_input, .page_current, .page_normal').forEach(el => el.remove());

      // let 以便 doRetry 内可重新赋值
      let maps = buildLookupMaps(allReplies);
      const readState = createReadState(topicId);
      let newCount = markUnread(readState, allReplies);
      renderTree(allReplies, maps, replyBox, topicId);
      UserTags.decorate(replyBox);
      syncIdentityColumn(replyBox);
      // 增删标签会改变最长那一项，列宽要跟着重算
      document.addEventListener('v2ex-tags-updated', () => syncIdentityColumn(replyBox));

      loadingBar.remove();
      document.querySelectorAll('a[name="last_page"]').forEach(e => e.remove());
      updateNewCountBar(replyBox, newCount);
      if (!failedPages.length) commitReadState(readState, allReplies);

      let hoverTimer = null;
      const scheduleHoverPreview = () => {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => initHoverPreview(allReplies, maps), 50);
      };

      // ── 失败页重试（支持递归多次重试）──
      if (failedPages.length > 0) {
        const banner = document.createElement('div');
        banner.id = 'v2ex-retry-banner';
        replyBox.parentNode.insertBefore(banner, replyBox);

        function attachRetry(pagesToRetry) {
          banner.innerHTML = `<span>⚠️ 第 ${pagesToRetry.join('、')} 页加载失败</span><button>重试</button>`;
          banner.querySelector('button').addEventListener('click', async () => {
            const btn = banner.querySelector('button');
            btn.textContent = '重试中…'; btn.disabled = true;

            const results = await fetchPages(pagesToRetry, (completed, total) => {
              btn.textContent = `重试中 ${completed}/${total}…`;
            });
            const stillFailed = results.filter(result => !result.replies).map(result => result.page);
            const newReplies = results.filter(result => result.replies).flatMap(result => result.replies);
            results.filter(result => !result.replies).forEach(result => {
              log(`Reply page ${result.page} retry failed:`, result.error);
            });

            if (newReplies.length > 0) {
              allReplies = normalizeReplies([...allReplies, ...newReplies]);
              maps = buildLookupMaps(allReplies);
              newCount = markUnread(readState, allReplies);
              renderTree(allReplies, maps, replyBox, topicId);
              UserTags.decorate(replyBox);
              syncIdentityColumn(replyBox);
              updateNewCountBar(replyBox, newCount);
              scheduleHoverPreview();
            }

            if (stillFailed.length > 0) {
              attachRetry(stillFailed); // 仍有失败页 → 重新挂载按钮
            } else {
              banner.remove();
              commitReadState(readState, allReplies);
            }
          });
        }
        attachRetry([...failedPages]);
      }

      // 等待 B64 的 MutationObserver 完成本轮 DOM 处理。
      scheduleHoverPreview();
    }

    function boot() {
      init().catch(err => {
        document.getElementById('v2ex-loading-bar')?.remove();
        log('ThreadTree error:', err);
      });
    }
    return { boot, revealAncestors };
  })();

  // =========================
  // 6) 功能D：高赞回复阅览室（含图片 Lightbox）
  // =========================
  const HotRoom = (() => {

    // ── Lightbox ──
    function openLightbox(src) {
      if (!src) return;
      let lb = document.getElementById('v2ex-lightbox');
      if (!lb) {
        lb = document.createElement('div');
        lb.id = 'v2ex-lightbox';
        const img = document.createElement('img');
        img.alt = '';
        lb.appendChild(img);
        document.body.appendChild(lb);
        lb.addEventListener('click', () => lb.classList.remove('active'));
        document.addEventListener('keydown', e => {
          if (e.key === 'Escape' && lb.classList.contains('active')) lb.classList.remove('active');
        });
      }
      lb.querySelector('img').src = src;
      requestAnimationFrame(() => lb.classList.add('active'));
    }

    function extractComments() {
      const comments = [];
      document.querySelectorAll('.cell[id^="r_"]').forEach(cell => {
        try {
          let likes = 0;
          for (const span of cell.querySelectorAll('.small.fade')) {
            const text = span.textContent || '';
            const m1 = text.match(/(?:♥|❤️)\s*(\d+)/);
            if (m1) { likes = parseInt(m1[1], 10); break; }
            if (span.querySelector('img[alt="❤️"]') && text.trim().length > 0) {
              likes = parseInt(text.trim(), 10) || 0; break;
            }
          }
          if (likes > 0) {
            const content = cell.querySelector('.reply_content');
            comments.push({
              id: cell.id, likes,
              avatar:      cell.querySelector('img.avatar')?.src || '',
              username:    cell.querySelector('strong > a')?.textContent?.trim() || 'Unknown',
              userUrl:     cell.querySelector('strong > a')?.href || '#',
              time:        cell.querySelector('.ago')?.textContent?.trim() || '',
              contentNode: content?.cloneNode(true) || null,
              floor:       cell.querySelector('.no')?.textContent?.trim() || '#',
            });
          }
        } catch (_) {}
      });
      return comments.sort((a, b) => b.likes - a.likes);
    }

    function buildUI(comments) {
      const existing = document.getElementById('hot-overlay');
      existing?._cleanup?.();
      existing?.remove();
      const overlay   = document.createElement('div');
      overlay.id      = 'hot-overlay';
      const container = document.createElement('div');
      container.className = 'hot-container';

      if (!comments.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center;padding:40px;color:#ccc;font-size:13px;';
        empty.textContent = '暂无高赞回复';
        container.appendChild(empty);
      } else {
        comments.forEach((c, index) => {
          const rankClass = index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : 'rank-normal';
          const card = document.createElement('div');
          card.className = `hot-card ${rankClass}`;

          const header = document.createElement('div');
          header.className = 'card-header-row';

          if (c.avatar) {
            const avatar = document.createElement('img');
            avatar.className = 'user-avatar'; avatar.src = c.avatar; avatar.alt = '';
            header.appendChild(avatar);
          }

          const user = document.createElement('a');
          user.className = 'user-name'; user.href = c.userUrl;
          user.target = '_blank'; user.rel = 'noreferrer noopener';
          user.textContent = c.username;
          header.appendChild(user);

          const floor = document.createElement('div');
          floor.className = 'floor-tag'; floor.title = '跳转'; floor.textContent = c.floor;
          floor.addEventListener('click', () => {
            closeOverlay(overlay);
            setTimeout(() => {
              const el = document.getElementById(c.id);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 250);
          });
          header.appendChild(floor);

          const time = document.createElement('span');
          time.className = 'time-tag'; time.textContent = c.time;
          header.appendChild(time);

          const likes = document.createElement('div');
          likes.className = 'likes-pill'; likes.textContent = `♥ ${c.likes}`;
          header.appendChild(likes);

          const content = document.createElement('div');
          content.className = 'card-content';
          if (c.contentNode) content.append(...c.contentNode.childNodes);

          // ── Lightbox：为卡片内图片挂载点击处理 ──
          content.querySelectorAll('img').forEach(img => {
            img.addEventListener('click', e => {
              e.stopPropagation();
              openLightbox(img.src);
            });
          });

          card.appendChild(header);
          card.appendChild(content);
          container.appendChild(card);
        });
      }

      overlay.appendChild(container);
      document.body.appendChild(overlay);
      // 浮层挂在 body 上，不在 UserTags 的观察范围内，需要显式装饰一次
      UserTags.decorate(overlay);
      overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(overlay); });
      const onKey = e => {
        if (e.key !== 'Escape' || document.getElementById('v2ex-lightbox')?.classList.contains('active')) return;
        closeOverlay(overlay);
      };
      document.addEventListener('keydown', onKey);
      overlay._cleanup = () => document.removeEventListener('keydown', onKey);
      return overlay;
    }

    function closeOverlay(overlay) {
      if (!overlay) return;
      overlay.classList.remove('active');
      setTimeout(() => {
        if (!overlay.classList.contains('active')) { overlay._cleanup?.(); overlay.remove(); }
      }, 200);
    }

    function boot() {
      if (!isTopicPage()) return;
      setTimeout(() => {
        const target = document.querySelector('#Main .header h1') || document.querySelector('#Main .box .header');
        if (target && !document.getElementById('v2ex-hot-btn')) {
          const btn = document.createElement('span');
          btn.id = 'v2ex-hot-btn'; btn.textContent = '高赞';
          btn.addEventListener('click', e => {
            e.preventDefault(); e.stopPropagation();
            const overlay = buildUI(extractComments());
            requestAnimationFrame(() => overlay.classList.add('active'));
          });
          target.appendChild(btn);
        }
      }, 500);
    }

    return { boot };
  })();

  // =========================
  // 7) 功能E：j/k 键盘导航（按需刷新，无常驻扫描）
  // =========================
  const NavKeys = (() => {
    const SCROLL_OFFSET_RATIO = CONFIG.nav.scrollOffsetRatio;
    let newReplies = [], curIndex = -1, hudTimer = null, activeReply = null;

    function getHud() {
      let hud = document.getElementById('v2ex-nav-hud');
      if (!hud) { hud = document.createElement('div'); hud.id = 'v2ex-nav-hud'; document.body.appendChild(hud); }
      return hud;
    }
    function showHud(index, total, direction) {
      const hud = getHud();
      hud.innerHTML = `
        <span class="hud-arrow">${direction === 'next' ? '↓' : '↑'}</span>
        <span class="hud-label">NEW</span>
        <span class="hud-count">${index + 1}<span class="hud-sep"> / </span>${total}</span>
        <span class="hud-hint">j↓ k↑</span>
      `;
      hud.classList.add('visible');
      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => hud.classList.remove('visible'), 2200);
    }
    function scrollToReply(el) {
      const targetTop = el.getBoundingClientRect().top + window.scrollY - window.innerHeight * SCROLL_OFFSET_RATIO;
      window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }
    function setActive(el) {
      document.querySelector('.reply-nav-active')?.classList.remove('reply-nav-active');
      activeReply = el || null;
      if (el) (el.closest('.reply-wrapper') || el).classList.add('reply-nav-active');
    }
    function refreshList() {
      newReplies = Array.from(document.querySelectorAll('.reply-new'));
      const activeIndex = activeReply ? newReplies.indexOf(activeReply) : -1;
      curIndex = activeIndex >= 0 ? activeIndex : -1;
    }
    function navigate(direction) {
      refreshList();
      if (!newReplies.length) return;
      curIndex = direction === 'next'
        ? Math.min(curIndex + 1, newReplies.length - 1)
        : (curIndex < 0 ? newReplies.length - 1 : Math.max(curIndex - 1, 0));
      const target = newReplies[curIndex];
      setActive(target);
      // 目标可能藏在折叠的子树里，先展开再滚动，否则会滚到一片空白
      ThreadTree.revealAncestors(target);
      scrollToReply(target);
      showHud(curIndex, newReplies.length, direction);
    }
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || document.activeElement?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // 有浮层时把按键让给浮层
      if (document.getElementById('hot-overlay')?.classList.contains('active')) return;
      if (document.getElementById('v2t-manager')?.classList.contains('active')) return;
      if (document.getElementById('v2ex-lightbox')?.classList.contains('active')) return;
      if (document.getElementById('v2t-editor')?.classList.contains('visible')) return;
      if (e.key === 'j') { e.preventDefault(); navigate('next'); }
      else if (e.key === 'k') { e.preventDefault(); navigate('prev'); }
    }
    function boot() {
      if (!isTopicPage()) return;
      document.addEventListener('keydown', onKeyDown);
    }
    return { boot };
  })();

  // =========================
  // 8) 功能F：Imgur 图片代理
  // =========================
  const ImgurProxy = (() => {
    function parseImgurUrl(value) {
      if (!value) return null;
      try {
        const url = new URL(value.startsWith('//') ? `https:${value}` : value, location.href);
        const host = url.hostname.toLowerCase();
        return host === 'imgur.com' || host.endsWith('.imgur.com') ? url : null;
      } catch (_) { return null; }
    }

    function proxyUrl(url) {
      return `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(url.href)}&f=1&nofb=1`;
    }

    function isDirectImage(url) {
      return url.hostname.toLowerCase() === 'i.imgur.com' || /\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname);
    }

    function processImage(img) {
      if (img.dataset.proxied === '1') return;
      const src = img.getAttribute('src');
      const imgurUrl = parseImgurUrl(src);
      if (!imgurUrl) return;
      img.dataset.proxied = '1';
      img.setAttribute('src', proxyUrl(imgurUrl));
      const parent = img.parentElement;
      if (parent?.tagName?.toLowerCase() === 'a') {
        const href = parseImgurUrl(parent.getAttribute('href'));
        if (href && isDirectImage(href)) parent.setAttribute('href', proxyUrl(href));
      }
    }

    function processNode(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches('img')) processImage(node);
      node.querySelectorAll('img').forEach(processImage);
    }

    function scanAll() { document.querySelectorAll('img[src*="imgur.com"]').forEach(processImage); }
    function boot() {
      scanAll();
      new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') processImage(mutation.target);
          else for (const node of mutation.addedNodes) processNode(node);
        }
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    }
    return { boot };
  })();

  // =========================
  // 9) 功能G：用户标签（本地存储 / 导入导出 / 合并）
  // =========================
  const UserTags = (() => {
    const { storeKey, maxTagLength, tombstoneTtlMs, exportVersion } = CONFIG.tags;

    // 主色（紫）排第一并作为默认值：不选颜色也能得到一致好看的标签。
    // 整套配色刻意不含 #4a7af0 —— 那是 NEW / 引用 / b64 的系统蓝，
    // 允许用户选到它就等于允许把"人的标签"伪装成"系统状态"。
    const COLORS = [
      { key: 'violet', hex: '#8b45c9', label: '默认紫' },
      { key: 'teal',   hex: '#0e8f8f', label: '青' },
      { key: 'green',  hex: '#2f8f4e', label: '绿' },
      { key: 'amber',  hex: '#b5730b', label: '琥珀' },
      { key: 'red',    hex: '#cf3b30', label: '红' },
      { key: 'pink',   hex: '#c72d78', label: '粉' },
      { key: 'slate',  hex: '#5f6b7a', label: '灰蓝' },
    ];
    const COLOR_MAP = new Map(COLORS.map(c => [c.key, c.hex]));
    const DEFAULT_COLOR = 'violet';

    // 会员链接出现的三处位置：回复楼层、主题头部作者、高赞阅览室卡片
    const AUTHOR_SELECTOR = [
      'div.cell[id^="r_"] strong > a[href*="/member/"]',
      '#Main .header small.gray > a[href*="/member/"]',
      '.hot-card a.user-name',
    ].join(',');

    // ── 存储层 ──
    // 结构：{ v, tags: { <小写用户名>: {name, tag, color, updatedAt} }, deleted: { <小写用户名>: ts } }
    // deleted 是墓碑，保证"删除"在跨浏览器合并时也能正确传播（否则旧数据会把删掉的标签复活）。
    let store = null;

    const emptyStore = () => ({ v: exportVersion, tags: {}, deleted: {} });
    const keyOf = name => String(name ?? '').trim().toLowerCase();

    function sanitizeEntry(raw, fallbackName) {
      if (!raw || typeof raw !== 'object') return null;
      const tag = typeof raw.tag === 'string' ? raw.tag.replace(/\s+/g, ' ').trim().slice(0, maxTagLength) : '';
      if (!tag) return null;
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : String(fallbackName ?? '').trim();
      const updatedAt = Number.isFinite(raw.updatedAt) && raw.updatedAt > 0 ? raw.updatedAt : 0;
      return {
        name: name || tag,
        tag,
        color: COLOR_MAP.has(raw.color) ? raw.color : DEFAULT_COLOR,
        updatedAt,
      };
    }

    function normalizeStore(raw) {
      const next = emptyStore();
      if (!raw || typeof raw !== 'object') return next;
      for (const [k, v] of Object.entries(raw.tags || {})) {
        const key = keyOf(k);
        const entry = sanitizeEntry(v, k);
        if (key && entry) next.tags[key] = entry;
      }
      for (const [k, v] of Object.entries(raw.deleted || {})) {
        const key = keyOf(k);
        const ts = Number(v);
        if (key && Number.isFinite(ts) && ts > 0) next.deleted[key] = ts;
      }
      return next;
    }

    function pruneTombstones(target, now = Date.now()) {
      for (const [k, ts] of Object.entries(target.deleted)) {
        if (now - ts > tombstoneTtlMs) delete target.deleted[k];
      }
      return target;
    }

    function load() {
      if (!store) store = normalizeStore(GM.get(storeKey, null));
      return store;
    }

    function persist(next) {
      pruneTombstones(next);
      store = next;
      GM.set(storeKey, next);
      repaintAll();
      Manager.refresh();
      // 通知楼层树重算身份列宽度（标签变了，最长的那一项可能也变了）
      document.dispatchEvent(new CustomEvent('v2ex-tags-updated'));
    }

    const get = name => load().tags[keyOf(name)] || null;

    function setTag(name, tag, color) {
      const key = keyOf(name);
      if (!key) return false;
      const entry = sanitizeEntry({ name, tag, color, updatedAt: Date.now() }, name);
      if (!entry) return removeTag(name);
      const next = { v: exportVersion, tags: { ...load().tags }, deleted: { ...load().deleted } };
      next.tags[key] = entry;
      delete next.deleted[key];
      persist(next);
      return true;
    }

    function removeTag(name) {
      const key = keyOf(name);
      const current = load();
      if (!key || !current.tags[key]) return false;
      const next = { v: exportVersion, tags: { ...current.tags }, deleted: { ...current.deleted } };
      delete next.tags[key];
      next.deleted[key] = Date.now();
      persist(next);
      return true;
    }

    function entries() {
      return Object.entries(load().tags)
        .map(([key, entry]) => ({ key, ...entry }))
        .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key));
    }

    // 最近使用过的标签文本，按使用频次 + 新旧排序，用作编辑气泡里的快捷输入
    function suggestions(limit = 8) {
      const counter = new Map();
      for (const entry of Object.values(load().tags)) {
        const item = counter.get(entry.tag) || { tag: entry.tag, count: 0, updatedAt: 0 };
        item.count++;
        item.updatedAt = Math.max(item.updatedAt, entry.updatedAt);
        counter.set(entry.tag, item);
      }
      return [...counter.values()]
        .sort((a, b) => b.count - a.count || b.updatedAt - a.updatedAt)
        .slice(0, limit);
    }

    // ── 导入 / 导出 / 合并 ──
    function exportPayload() {
      const current = load();
      return {
        app: 'v2ex-tweaks',
        kind: 'user-tags',
        version: exportVersion,
        exportedAt: Date.now(),
        count: Object.keys(current.tags).length,
        tags: current.tags,
        deleted: current.deleted,
      };
    }

    // 兼容三种输入：本脚本导出的完整包、只有 {tags:{…}} 的裁剪包、
    // 以及手写的 { 用户名: "标签文本" } 简易映射。
    function parseImport(text) {
      let data;
      try { data = JSON.parse(text); }
      catch (_) { throw new Error('不是合法的 JSON 文件'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('文件内容不是标签数据');

      // 带信封的导出包必须走 data.tags，否则 app/kind/version 这些元字段会被当成用户名
      const hasEnvelope = ['app', 'kind', 'version', 'exportedAt', 'count', 'tags', 'deleted']
        .some(field => field in data);
      if (hasEnvelope && (!data.tags || typeof data.tags !== 'object')) {
        throw new Error('文件缺少 tags 字段');
      }
      const rawTags = hasEnvelope ? data.tags : data;
      const rawDeleted = (data.deleted && typeof data.deleted === 'object') ? data.deleted : {};

      const tags = {};
      const deleted = {};
      let invalid = 0;
      for (const [k, v] of Object.entries(rawTags)) {
        const key = keyOf(k);
        const entry = typeof v === 'string' ? sanitizeEntry({ tag: v }, k) : sanitizeEntry(v, k);
        if (!key || !entry) { invalid++; continue; }
        if (!tags[key] || entry.updatedAt > tags[key].updatedAt) tags[key] = entry;
      }
      for (const [k, v] of Object.entries(rawDeleted)) {
        const key = keyOf(k);
        const ts = Number(v);
        if (key && Number.isFinite(ts) && ts > 0) deleted[key] = ts;
      }
      if (!Object.keys(tags).length && !Object.keys(deleted).length) throw new Error('文件里没有可导入的标签');
      return { tags, deleted, invalid };
    }

    // strategy: smart（按更新时间取新，尊重删除墓碑）/ add（只补充本地没有的）/ replace（用文件完全覆盖）
    function computeMerge(incoming, strategy) {
      const base = load();
      const next = strategy === 'replace'
        ? emptyStore()
        : { v: exportVersion, tags: { ...base.tags }, deleted: { ...base.deleted } };

      for (const [key, entry] of Object.entries(incoming.tags)) {
        const local = next.tags[key];
        if (strategy === 'add') {
          if (!local) { next.tags[key] = entry; delete next.deleted[key]; }
          continue;
        }
        if (strategy === 'smart' && (next.deleted[key] || 0) > entry.updatedAt) continue;
        if (!local || entry.updatedAt > local.updatedAt) {
          next.tags[key] = entry;
          delete next.deleted[key];
        }
      }

      if (strategy !== 'add') {
        for (const [key, ts] of Object.entries(incoming.deleted)) {
          const local = next.tags[key];
          if (local && ts > local.updatedAt) delete next.tags[key];
          if (!next.tags[key]) next.deleted[key] = Math.max(next.deleted[key] || 0, ts);
        }
      }

      pruneTombstones(next);

      const stats = { added: 0, updated: 0, removed: 0, unchanged: 0, invalid: incoming.invalid };
      for (const [key, entry] of Object.entries(next.tags)) {
        const local = base.tags[key];
        if (!local) stats.added++;
        else if (local.tag !== entry.tag || local.color !== entry.color) stats.updated++;
        else stats.unchanged++;
      }
      for (const key of Object.keys(base.tags)) if (!next.tags[key]) stats.removed++;
      return { stats, next };
    }

    function download(filename, text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }

    // ── Toast ──
    let toastTimer = 0;
    function toast(message) {
      let el = document.getElementById('v2t-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'v2t-toast';
        document.body.appendChild(el);
      }
      el.textContent = message;
      requestAnimationFrame(() => el.classList.add('visible'));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => el.classList.remove('visible'), 2200);
    }

    // ── 胶囊渲染 ──
    function lightenHex(hex, amount) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return hex;
      const n = parseInt(m[1], 16);
      const mix = c => Math.round(c + (255 - c) * amount);
      const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
      return `rgb(${r}, ${g}, ${b})`;
    }

    function userFromLink(anchor) {
      try {
        const path = new URL(anchor.getAttribute('href') || '', location.origin).pathname;
        const m = /^\/member\/([^/?#]+)/.exec(path);
        return m ? decodeURIComponent(m[1]) : '';
      } catch (_) { return ''; }
    }

    function paintSlot(slot) {
      const user = slot.dataset.user;
      const entry = get(user);
      if (entry) {
        const hex = COLOR_MAP.get(entry.color) || COLOR_MAP.get(DEFAULT_COLOR);
        const chip = document.createElement('span');
        chip.className = 'v2t-chip';
        chip.textContent = entry.tag;
        // 标签在楼层头部可能被省略号截断，完整文案放进 title 兜底
        chip.title = `${entry.tag} · ${entry.name || user}\n点击编辑标签`;
        chip.setAttribute('role', 'button');
        chip.tabIndex = 0;
        chip.style.setProperty('--v2t-chip-bg', hexToRgba(hex, 0.13));
        chip.style.setProperty('--v2t-chip-fg', hex);
        chip.style.setProperty('--v2t-chip-bd', hexToRgba(hex, 0.32));
        chip.style.setProperty('--v2t-chip-bg-n', hexToRgba(hex, 0.22));
        chip.style.setProperty('--v2t-chip-fg-n', lightenHex(hex, 0.38));
        chip.style.setProperty('--v2t-chip-bd-n', hexToRgba(hex, 0.45));
        slot.replaceChildren(chip);
        return;
      }
      const add = document.createElement('span');
      add.className = 'v2t-add';
      add.textContent = '+';
      add.title = `给 ${user} 添加标签`;
      add.setAttribute('role', 'button');
      add.setAttribute('aria-label', `给 ${user} 添加标签`);
      add.tabIndex = 0;
      slot.replaceChildren(add);
    }

    function attachSlot(anchor) {
      if (anchor.dataset.v2tBound === '1') return;
      const user = userFromLink(anchor);
      if (!user) return;
      anchor.dataset.v2tBound = '1';
      const slot = document.createElement('span');
      slot.className = 'v2t-slot';
      slot.dataset.user = user;
      anchor.insertAdjacentElement('afterend', slot);
      paintSlot(slot);
    }

    function decorate(root = document) {
      if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(AUTHOR_SELECTOR)) attachSlot(root);
      root.querySelectorAll?.(AUTHOR_SELECTOR).forEach(attachSlot);
    }

    function repaintAll() {
      document.querySelectorAll('.v2t-slot').forEach(paintSlot);
    }

    // ── 编辑气泡 ──
    const Editor = (() => {
      let el = null;
      let currentUser = '';
      let currentColor = DEFAULT_COLOR;
      let anchorEl = null;

      function place() {
        if (!el || !anchorEl?.isConnected) return;
        const rect = anchorEl.getBoundingClientRect();
        const width = el.offsetWidth || 268;
        const height = el.offsetHeight || 180;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const top = (window.innerHeight - rect.bottom > height + 12)
          ? rect.bottom + 8
          : Math.max(8, rect.top - height - 8);
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
      }

      function close() {
        if (!el) return;
        el.classList.remove('visible');
        el.style.pointerEvents = 'none';
        currentUser = '';
        anchorEl = null;
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      }

      function isOpen() { return !!currentUser; }

      function build() {
        el = document.createElement('div');
        el.id = 'v2t-editor';
        document.body.appendChild(el);
        // 气泡内部的点击不能冒泡到"点击外部关闭"的全局监听
        el.addEventListener('mousedown', e => e.stopPropagation());
        return el;
      }

      function open(user, anchor) {
        if (!el) build();
        if (currentUser && keyOf(currentUser) === keyOf(user)) { close(); return; }
        currentUser = user;
        anchorEl = anchor;
        const existing = get(user);
        currentColor = existing?.color || DEFAULT_COLOR;

        el.replaceChildren();

        const head = document.createElement('div');
        head.className = 'v2t-ed-head';
        const avatar = anchor.closest('.cell, .hot-card, .header')?.querySelector('img.avatar, img.user-avatar');
        if (avatar?.src) {
          const img = document.createElement('img');
          img.src = avatar.src;
          img.alt = '';
          head.appendChild(img);
        }
        const nameEl = document.createElement('b');
        nameEl.textContent = user;
        head.append(nameEl, document.createTextNode(existing ? '· 编辑标签' : '· 新建标签'));

        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = maxTagLength;
        input.placeholder = '例如：靠谱 / 杠精 / 同行…';
        input.value = existing?.tag || '';
        input.setAttribute('aria-label', `${user} 的标签`);

        // 配色是可选项：默认收起，只有在改过颜色的标签上才自动展开
        const toggle = document.createElement('div');
        toggle.className = 'v2t-color-toggle';
        toggle.setAttribute('role', 'button');
        const preview = document.createElement('span');
        preview.className = 'v2t-color-preview';
        const toggleText = document.createElement('span');
        toggle.append(preview, toggleText);

        const swatches = document.createElement('div');
        swatches.className = 'v2t-swatches';

        const syncColor = () => {
          const hex = COLOR_MAP.get(currentColor) || COLOR_MAP.get(DEFAULT_COLOR);
          preview.style.background = hex;
          const name = COLORS.find(c => c.key === currentColor)?.label || '';
          toggleText.textContent = swatches.classList.contains('open') ? '收起配色' : `配色：${name}`;
        };

        for (const { key, hex, label } of COLORS) {
          const dot = document.createElement('span');
          dot.className = 'v2t-swatch' + (key === currentColor ? ' selected' : '');
          dot.style.background = hex;
          dot.style.color = hex;
          dot.title = label;
          dot.setAttribute('role', 'button');
          dot.setAttribute('aria-label', `颜色 ${label}`);
          dot.addEventListener('click', () => {
            currentColor = key;
            swatches.querySelectorAll('.v2t-swatch').forEach(s => s.classList.remove('selected'));
            dot.classList.add('selected');
            syncColor();
            input.focus();
          });
          swatches.appendChild(dot);
        }

        toggle.addEventListener('click', () => {
          swatches.classList.toggle('open');
          syncColor();
          place();
        });
        if (existing && existing.color !== DEFAULT_COLOR) swatches.classList.add('open');
        syncColor();

        el.append(head, input, toggle, swatches);

        const recent = suggestions().filter(item => item.tag !== input.value);
        if (recent.length) {
          const list = document.createElement('div');
          list.className = 'v2t-recent';
          for (const item of recent) {
            const chip = document.createElement('span');
            chip.className = 'v2t-recent-item';
            chip.textContent = item.tag;
            chip.title = `已用于 ${item.count} 人`;
            chip.addEventListener('click', () => { input.value = item.tag; input.focus(); });
            list.appendChild(chip);
          }
          el.appendChild(list);
        }

        const actions = document.createElement('div');
        actions.className = 'v2t-ed-actions';
        if (existing) {
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'v2t-btn danger';
          del.textContent = '删除';
          del.addEventListener('click', () => {
            removeTag(user);
            toast(`已删除 ${user} 的标签`);
            close();
          });
          actions.appendChild(del);
        }
        const spacer = document.createElement('span');
        spacer.className = 'v2t-spacer';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'v2t-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', close);
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'v2t-btn primary';
        save.textContent = '保存';

        const commit = () => {
          const value = input.value.trim();
          if (!value) {
            if (existing) { removeTag(user); toast(`已删除 ${user} 的标签`); }
            close();
            return;
          }
          setTag(user, value, currentColor);
          toast(`已${existing ? '更新' : '添加'} ${user} 的标签`);
          close();
        };
        save.addEventListener('click', commit);
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); close(); }
        });

        actions.append(spacer, cancel, save);
        el.appendChild(actions);

        el.style.pointerEvents = 'auto';
        place();
        requestAnimationFrame(() => {
          el.classList.add('visible');
          place();
          input.focus();
          input.select();
        });
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
      }

      return { open, close, isOpen };
    })();

    // ── 管理面板 ──
    const Manager = (() => {
      let overlay = null;
      let listEl = null;
      let countEl = null;
      let mergeEl = null;
      let searchEl = null;
      let pending = null; // 待确认的导入数据
      let strategy = 'smart';

      function isOpen() { return !!overlay?.classList.contains('active'); }

      function renderList() {
        if (!listEl) return;
        const keyword = (searchEl?.value || '').trim().toLowerCase();
        const all = entries();
        const rows = keyword
          ? all.filter(item => item.key.includes(keyword) || item.tag.toLowerCase().includes(keyword))
          : all;

        countEl.textContent = keyword ? `${rows.length} / ${all.length}` : `${all.length} 个用户`;
        listEl.replaceChildren();

        if (!rows.length) {
          const empty = document.createElement('div');
          empty.className = 'v2t-empty';
          empty.textContent = all.length ? '没有匹配的标签' : '还没有标签，在主题页把鼠标移到用户名旁点 + 即可添加';
          listEl.appendChild(empty);
          return;
        }

        const fragment = document.createDocumentFragment();
        for (const item of rows) {
          const row = document.createElement('div');
          row.className = 'v2t-row';

          const user = document.createElement('a');
          user.className = 'v2t-user';
          user.href = `/member/${encodeURIComponent(item.name || item.key)}`;
          user.target = '_blank';
          user.rel = 'noreferrer noopener';
          user.textContent = item.name || item.key;

          const slot = document.createElement('span');
          slot.className = 'v2t-slot';
          slot.dataset.user = item.name || item.key;
          paintSlot(slot);

          const time = document.createElement('span');
          time.className = 'v2t-time';
          time.textContent = item.updatedAt ? new Date(item.updatedAt).toLocaleDateString() : '—';

          const edit = document.createElement('span');
          edit.className = 'v2t-row-act';
          edit.textContent = '编辑';
          edit.setAttribute('role', 'button');
          edit.addEventListener('click', () => Editor.open(item.name || item.key, edit));

          const del = document.createElement('span');
          del.className = 'v2t-row-act danger';
          del.textContent = '删除';
          del.setAttribute('role', 'button');
          del.addEventListener('click', () => { removeTag(item.key); });

          row.append(user, slot, time, edit, del);
          fragment.appendChild(row);
        }
        listEl.appendChild(fragment);
      }

      function renderMerge() {
        if (!mergeEl) return;
        if (!pending) {
          mergeEl.hidden = true;
          mergeEl.replaceChildren();
          return;
        }
        const { stats } = computeMerge(pending, strategy);
        mergeEl.hidden = false;
        mergeEl.replaceChildren();

        const title = document.createElement('div');
        title.innerHTML = `准备导入 <b>${Object.keys(pending.tags).length}</b> 条标签`
          + (pending.invalid ? `（已忽略 <b>${pending.invalid}</b> 条无效记录）` : '');

        const opts = document.createElement('div');
        opts.className = 'v2t-merge-opts';
        const choices = [
          ['smart', '智能合并（保留较新，推荐）'],
          ['add', '仅新增（不动本地已有）'],
          ['replace', '覆盖本地（清空后导入）'],
        ];
        for (const [value, label] of choices) {
          const wrap = document.createElement('label');
          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'v2t-merge-strategy';
          radio.value = value;
          radio.checked = strategy === value;
          radio.addEventListener('change', () => { strategy = value; renderMerge(); });
          wrap.append(radio, document.createTextNode(label));
          opts.appendChild(wrap);
        }

        const summary = document.createElement('div');
        summary.innerHTML = `结果：新增 <b>${stats.added}</b> · 更新 <b>${stats.updated}</b> · 删除 <b>${stats.removed}</b> · 不变 <b>${stats.unchanged}</b>`;

        const actions = document.createElement('div');
        actions.className = 'v2t-ed-actions';
        const spacer = document.createElement('span');
        spacer.className = 'v2t-spacer';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'v2t-btn';
        cancel.textContent = '取消';
        cancel.addEventListener('click', () => { pending = null; renderMerge(); });
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'v2t-btn primary';
        apply.textContent = '应用';
        apply.addEventListener('click', () => {
          const { stats: applied, next } = computeMerge(pending, strategy);
          pending = null;
          persist(next);
          toast(`导入完成：新增 ${applied.added} · 更新 ${applied.updated} · 删除 ${applied.removed}`);
        });
        actions.append(spacer, cancel, apply);

        mergeEl.append(title, opts, summary, actions);
      }

      function pickFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          input.remove();
          if (!file) return;
          try {
            pending = parseImport(await file.text());
            strategy = 'smart';
            renderMerge();
          } catch (err) {
            pending = null;
            renderMerge();
            toast(`导入失败：${err.message}`);
          }
        }, { once: true });
        input.click();
      }

      function build() {
        overlay = document.createElement('div');
        overlay.id = 'v2t-manager';

        const panel = document.createElement('div');
        panel.className = 'v2t-panel';

        const head = document.createElement('div');
        head.className = 'v2t-panel-head';
        const title = document.createElement('span');
        title.className = 'v2t-title';
        title.textContent = '用户标签';
        countEl = document.createElement('span');
        countEl.className = 'v2t-count';
        searchEl = document.createElement('input');
        searchEl.type = 'text';
        searchEl.className = 'v2t-search';
        searchEl.placeholder = '搜索用户或标签…';
        searchEl.addEventListener('input', debounce(renderList, 120));
        head.append(title, countEl, searchEl);

        listEl = document.createElement('div');
        listEl.className = 'v2t-list';

        mergeEl = document.createElement('div');
        mergeEl.className = 'v2t-merge';
        mergeEl.hidden = true;

        const foot = document.createElement('div');
        foot.className = 'v2t-panel-foot';
        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'v2t-btn';
        exportBtn.textContent = '导出';
        exportBtn.addEventListener('click', () => {
          const payload = exportPayload();
          if (!payload.count) { toast('还没有标签可导出'); return; }
          download(`v2ex-user-tags-${ymd()}.json`, JSON.stringify(payload, null, 2));
          toast(`已导出 ${payload.count} 条标签`);
        });
        const importBtn = document.createElement('button');
        importBtn.type = 'button';
        importBtn.className = 'v2t-btn';
        importBtn.textContent = '导入';
        importBtn.addEventListener('click', pickFile);
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'v2t-btn danger';
        clearBtn.textContent = '清空';
        clearBtn.addEventListener('click', () => {
          const current = load();
          const total = Object.keys(current.tags).length;
          if (!total) { toast('没有可清空的标签'); return; }
          if (!window.confirm(`确定删除全部 ${total} 条标签？此操作不可撤销。`)) return;
          const next = { v: exportVersion, tags: {}, deleted: { ...current.deleted } };
          const now = Date.now();
          for (const key of Object.keys(current.tags)) next.deleted[key] = now;
          persist(next);
          toast('已清空全部标签');
        });
        const spacer = document.createElement('span');
        spacer.className = 'v2t-spacer';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'v2t-btn';
        closeBtn.textContent = '关闭';
        closeBtn.addEventListener('click', close);
        foot.append(exportBtn, importBtn, clearBtn, spacer, closeBtn);

        panel.append(head, listEl, mergeEl, foot);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
      }

      function onKey(e) {
        if (e.key === 'Escape' && isOpen() && !Editor.isOpen()) close();
      }

      function open() {
        if (!overlay) build();
        pending = null;
        searchEl.value = '';
        renderMerge();
        renderList();
        overlay.classList.add('active');
        document.addEventListener('keydown', onKey);
        searchEl.focus();
      }

      function close() {
        if (!overlay) return;
        Editor.close();
        overlay.classList.remove('active');
        document.removeEventListener('keydown', onKey);
      }

      function refresh() {
        if (isOpen()) { renderList(); renderMerge(); }
      }

      return { open, close, refresh, isOpen };
    })();

    // ── 装载 ──
    function boot() {
      decorate(document);

      // 统一委托：胶囊 / + 按钮 / 点击空白关闭气泡
      document.addEventListener('click', e => {
        const trigger = e.target.closest?.('.v2t-chip, .v2t-add');
        if (!trigger) return;
        const slot = trigger.closest('.v2t-slot');
        if (!slot?.dataset.user) return;
        e.preventDefault();
        e.stopPropagation();
        Editor.open(slot.dataset.user, trigger);
      });
      document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const trigger = e.target.closest?.('.v2t-chip, .v2t-add');
        if (!trigger) return;
        e.preventDefault();
        trigger.click();
      });
      document.addEventListener('mousedown', e => {
        if (Editor.isOpen() && !e.target.closest?.('.v2t-chip, .v2t-add, #v2t-editor')) Editor.close();
      });

      const rescan = debounce(() => decorate(document), 150);
      const root = document.getElementById('Main') || document.body;
      new MutationObserver(rescan).observe(root, { childList: true, subtree: true });

      // 其它标签页改动标签后同步刷新
      GM.onChange(storeKey, next => {
        store = next === undefined ? null : normalizeStore(next);
        repaintAll();
        Manager.refresh();
      });

      GM.menu('用户标签管理…', () => Manager.open());

      if (isTopicPage()) {
        const mount = () => {
          const target = document.querySelector('#Main .header h1') || document.querySelector('#Main .box .header');
          if (!target || document.getElementById('v2t-entry')) return;
          const btn = document.createElement('span');
          btn.id = 'v2t-entry';
          btn.textContent = '标签';
          btn.title = '管理用户标签（导入 / 导出）';
          btn.setAttribute('role', 'button');
          btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            Manager.open();
          });
          target.appendChild(btn);
        };
        setTimeout(mount, 520);
      }
    }

    return { boot, decorate, open: () => Manager.open() };
  })();

  // =========================
  // 10) 启动
  // =========================
  Daily.boot();
  UserTags.boot();
  if (isTopicPage()) {
    ThreadTree.boot();
    B64.boot();
    HotRoom.boot();
    NavKeys.boot();
    ImgurProxy.boot();
  }
})();
