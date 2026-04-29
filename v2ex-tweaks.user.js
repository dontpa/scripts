// ==UserScript==
// @name         V2EX Tweaks
// @namespace    https://tampermonkey.net/
// @version      2.1.2
// @description  V2EX 日常增强：回复按引用关系重组为嵌套树并合并所有分页；自动标记未读新回复，j/k 键快速跳转；高赞回复一键全屏浏览；Base64 自动解码内联展示；每日签到静默后台完成；Imgur 图片自动走代理加载。
// @author       you
// @match        https://v2ex.com/*
// @match        https://www.v2ex.com/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  // =========================
  // 0) 通用小工具
  // =========================
  const log = (...args) => console.log('[V2EX-Enhance]', ...args);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function notify(title, text, timeout = 3500) {
    try {
      GM_notification({ title, text, timeout });
    } catch (_) {}
  }

  function ymdLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function isTopicPage() {
    return /^\/t\/\d+/.test(location.pathname);
  }

  // =========================
  // 1) 样式（合并注入）
  // =========================
  GM_addStyle(`
    /* ===== 楼层树（Hacker News Style）===== */
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

    /* ── 树形缩进容器 ── */
    .reply-children {
      margin-left: var(--indent-width);
      border-left: 2px solid var(--line-color);
      transition: border-color 0.2s, opacity 0.2s;
      position: relative;
    }

    /* 折叠状态 */
    .reply-children.is-collapsed {
      display: none;
    }

    /* 可折叠的缩进线：hover 时变蓝，提示可点击 */
    /* cursor: pointer 只作用于左侧 20px 伪元素，与 JS 的判断区域对齐 */
    .reply-children.collapsible {
      cursor: default;
    }
    .reply-children.collapsible::before {
      content: '';
      position: absolute;
      left: -2px;   /* 盖住 2px 的 border 本身 */
      top: 0;
      bottom: 0;
      width: 20px;
      cursor: pointer;
    }
    .reply-children.collapsible:hover {
      border-left-color: var(--line-hover);
    }
    /* 禁止子节点的 click 冒泡到父缩进线 */
    .reply-children .reply-children {
      pointer-events: auto;
    }

    /* ── 折叠指示器 badge ── */
    .reply-collapsed-hint {
      display: none;
      font-size: 11px;
      color: #999;
      padding: 3px 8px 3px calc(var(--indent-width) + 4px);
      cursor: pointer;
      user-select: none;
      transition: color 0.15s;
    }
    .reply-collapsed-hint:hover { color: var(--new-accent); }
    .reply-children.is-collapsed + .reply-collapsed-hint {
      display: block;
    }

    /* ── 单条回复 ── */
    .reply-wrapper .cell {
      padding: 6px 8px !important;
      border-bottom: 1px solid #f5f5f5 !important;
      background: transparent;
      transition: background 0.12s;
    }
    .reply-wrapper > .cell:hover { background-color: var(--bg-hover); }

    .reply-wrapper .avatar {
      display: block;
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      aspect-ratio: 1 / 1;
      object-fit: cover;
      flex: none;
      max-inline-size: 100% !important;
      border-radius: 4px;
      margin: 0 auto;
    }
    .reply_content {
      font-size: 14px;
      line-height: 1.5;
      margin-top: 2px;
    }
    .ago, .no, .fade { font-size: 11px !important; }

    /* ── 未读新回复高亮 ── */
    .reply-new > .cell {
      background: linear-gradient(
        90deg,
        rgba(74, 122, 240, 0.10) 0%,
        rgba(74, 122, 240, 0.04) 50%,
        transparent 100%
      ) !important;
      border-left: 3px solid #4a7af0 !important;
      padding-left: 5px !important;
      animation: new-reply-flash 0.6s ease-out;
    }

    @keyframes new-reply-flash {
      0%   { background-color: rgba(74, 122, 240, 0.18); }
      100% { background-color: transparent; }
    }

    /* ── NEW 角标 ──
       改为放在楼层号之后（strong 的右侧），脱离加粗 strong 上下文
       使用 outline 风格，不抢眼但清晰可辨
    */
    .new-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 700;
      color: var(--new-accent);
      background: transparent;
      border: 1px solid rgba(74, 122, 240, 0.45);
      border-radius: 3px;
      padding: 0 3px;
      line-height: 14px;
      height: 14px;
      /* 放在 strong 右侧，与 .ago 同排 */
      margin-left: 5px;
      margin-right: 2px;
      vertical-align: middle;
      letter-spacing: 0.5px;
      position: relative;
      top: -1px;
    }

    /* ── 新回复数量提示条 ── */
    #v2ex-new-count-bar {
      padding: 6px 12px;
      background: linear-gradient(90deg, #eef2ff 0%, #f8f9ff 100%);
      border-bottom: 1px solid #dde5ff;
      border-radius: 4px 4px 0 0;
      font-size: 12px;
      color: #6680cc;
      display: flex;
      align-items: center;
      gap: 6px;
      user-select: none;
    }
    #v2ex-new-count-bar .ncb-dot {
      width: 6px; height: 6px;
      background: var(--new-accent);
      border-radius: 50%;
      flex-shrink: 0;
    }
    #v2ex-new-count-bar strong { color: var(--new-accent); font-weight: 700; }
    #v2ex-new-count-bar .ncb-hint {
      margin-left: auto;
      opacity: 0.5;
      font-size: 11px;
    }

    #v2ex-loading-bar {
      padding: 8px;
      background: #fff;
      text-align: center;
      border-bottom: 1px solid #eee;
      font-size: 12px;
      color: #999;
    }
    .cell[style*="text-align: center"], #bottom-pagination, a[name="last_page"] { display: none; }

    /* ===== j/k 导航 HUD ===== */
    #v2ex-nav-hud {
      position: fixed;
      bottom: 28px;
      right: 28px;
      z-index: 99998;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px 6px 10px;
      background: rgba(22, 27, 46, 0.90);
      color: #dde4ff;
      border-radius: 20px;
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0.3px;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,255,255,0.06);
      pointer-events: none;
      opacity: 0;
      transform: translateY(8px) scale(0.97);
      transition: opacity 0.18s ease, transform 0.18s ease;
    }
    #v2ex-nav-hud.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    #v2ex-nav-hud .hud-arrow {
      font-size: 13px;
      opacity: 0.7;
    }
    #v2ex-nav-hud .hud-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
      color: #7fa8ff;
      opacity: 0.8;
    }
    #v2ex-nav-hud .hud-count {
      font-weight: 600;
      color: #c5d5ff;
      font-variant-numeric: tabular-nums;
    }
    #v2ex-nav-hud .hud-sep { opacity: 0.2; }
    #v2ex-nav-hud .hud-hint {
      opacity: 0.35;
      font-size: 11px;
      font-family: monospace;
    }

    /* 键盘导航当前高亮 */
    .reply-nav-active > .cell {
      outline: 2px solid rgba(74, 122, 240, 0.50) !important;
      outline-offset: -2px;
      transition: outline 0.15s ease;
    }

     /* ===== Base64 原地解码 ===== */

    /* 包裹容器：允许长 URL 换行，避免溢出 */
    .v2-b64-wrap {
      word-break: break-all;
    }

    /* URL → 可点击链接，颜色与脚本 --new-accent 蓝色系一致 */
    .v2-b64-link {
      color: #4a7af0 !important;
      text-decoration: none;
    }
    .v2-b64-link:hover {
      color: #3060d8 !important;
      text-decoration: underline;
    }

    /* 纯文本 / JSON → 带点状下划线，hover 提示原文 */
    .v2-b64-plain {
      text-decoration: underline;
      text-decoration-style: dotted;
      text-decoration-color: #8aa8f8;
      text-underline-offset: 2px;
      cursor: help;
    }

    /* b64 来源角标：放在内容左侧，与脚本蓝色体系协调 */
    .v2-b64-mark {
      display: inline-block;
      font-size: 9px;
      font-weight: 700;
      font-style: normal;
      color: #8aa8f8;
      border: 1px solid #d0defe;
      border-radius: 2px;
      padding: 0 3px;
      line-height: 13px;
      vertical-align: middle;
      position: relative;
      top: -1px;
      margin-right: 4px;
      cursor: default;
      user-select: none;
      text-decoration: none !important;
      letter-spacing: 0.2px;
    }

    /* ===== 高赞阅览室 ===== */
    #v2ex-hot-btn {
      display: inline-block;
      margin-left: 10px;
      padding: 2px 10px;
      background-color: #f0f2f5;
      color: #ccc;
      border-radius: 12px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      line-height: 1.5;
      border: 1px solid transparent;
    }
    #v2ex-hot-btn:hover {
      background-color: #e3e8f0;
      color: #555;
      border-color: #ccc;
    }

    #hot-overlay {
      position: fixed;
      top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(240, 242, 245, 0.95);
      z-index: 99999;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      overflow-y: scroll;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.15s ease;
    }
    #hot-overlay.active { opacity: 1; visibility: visible; }

    .hot-container {
      width: 92%;
      max-width: 1000px;
      margin: 30px auto 80px auto;
      background: #fff;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.08);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow: hidden;
      padding: 0;
    }

    .hot-card {
      background: #fff;
      padding: 14px 24px;
      border-bottom: 1px solid #f0f0f0;
      display: flex;
      flex-direction: column;
      transition: background 0.1s;
    }
    .hot-card:last-child { border-bottom: none; }
    .hot-card:hover { background: #fafafa; }

    .rank-1 { border-left: 3px solid #faad14; background: linear-gradient(90deg, #fffdf5 0%, #fff 100%); }
    .rank-2 { border-left: 3px solid #ccc; }
    .rank-3 { border-left: 3px solid #d48806; }

    .card-header-row {
      display: flex;
      align-items: center;
      margin-bottom: 6px;
      font-size: 12px;
    }
    .user-avatar {
      display: block;
      width: 18px; min-width: 18px; max-width: 18px;
      height: 18px; min-height: 18px; max-height: 18px;
      aspect-ratio: 1 / 1;
      object-fit: cover;
      flex: none;
      max-inline-size: none;
      border-radius: 3px;
      margin-right: 8px;
    }
    .user-name { font-weight: 600; color: #444; text-decoration: none; margin-right: 8px; }

    .floor-tag {
      background: #f5f5f5; color: #aaa;
      padding: 0 5px; border-radius: 3px;
      margin-right: 10px; cursor: pointer;
      font-size: 11px;
      height: 18px; line-height: 18px;
    }
    .floor-tag:hover { background: #e6f7ff; color: #1890ff; }
    .time-tag { color: #ddd; margin-right: auto; transform: scale(0.9); transform-origin: left; }

    .likes-pill { font-size: 12px; font-weight: 600; padding: 0 6px; }
    .rank-1 .likes-pill { color: #faad14; }
    .rank-normal .likes-pill { color: #ff6b6b; opacity: 0.8; }

    .card-content {
      font-size: 14px;
      line-height: 1.6;
      color: #222;
      word-wrap: break-word;
      padding-left: 26px;
    }
    .card-content p { margin: 0 0 5px 0; }
    .card-content img { max-width: 100%; max-height: 350px; border-radius: 4px; margin: 5px 0; display: block; cursor: zoom-in; }
    .card-content pre { padding: 10px; background: #f8f8f8; border: 1px solid #eee; border-radius: 3px; font-size: 12px; margin: 8px 0; }

    #hot-overlay::-webkit-scrollbar { width: 4px; }
    #hot-overlay::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
  `);

  // =========================
  // 2) 功能A：每日自动签到
  // =========================
  const Daily = (() => {
    const CFG = {
      dailyPage: '/mission/daily',
      delayMinMs: 1500,
      delayMaxMs: 3800,
      storeKey: 'v2ex_daily_check_ymd_v2',
      notify: true,
    };

    function isLoggedIn() {
      const hasSignOut = !!document.querySelector('a[href="/signout"]');
      const hasSignIn = !!document.querySelector('a[href="/signin"]');
      return hasSignOut || !hasSignIn;
    }

    async function fetchText(url) {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    }

    function parseHtml(html) {
      return new DOMParser().parseFromString(html, 'text/html');
    }

    function alreadyRedeemed(doc) {
      const text = doc.body?.innerText || '';
      return /已领取|已经领取|每日登录奖励已领取|redeemed|already redeemed|已完成/.test(text);
    }

    function findRedeemUrl(doc) {
      const a = doc.querySelector('a[href^="/mission/daily/redeem"]');
      if (a?.getAttribute('href')) return a.getAttribute('href');

      const btn = doc.querySelector('input[type="button"][onclick*="redeem"], input[value^="领取"][onclick]');
      if (btn) {
        const onclick = btn.getAttribute('onclick') || '';
        const m = onclick.match(/'([^']+)'/);
        if (m?.[1]) return m[1];
      }

      const any = [...doc.querySelectorAll('[onclick]')].find(el => (el.getAttribute('onclick') || '').includes('/mission/daily/redeem'));
      if (any) {
        const s = any.getAttribute('onclick') || '';
        const m = s.match(/'([^']+)'/);
        if (m?.[1]) return m[1];
      }
      return null;
    }

    async function run() {
      if (!CFG.notify) return;
      if (!isLoggedIn()) return;

      const today = ymdLocal();
      const last = GM_getValue(CFG.storeKey, '');
      if (last === today) return;

      GM_setValue(CFG.storeKey, today);
      await sleep(randInt(CFG.delayMinMs, CFG.delayMaxMs));

      const html1 = await fetchText(CFG.dailyPage);
      const doc1 = parseHtml(html1);

      if (alreadyRedeemed(doc1)) {
        if (CFG.notify) notify('V2EX 签到', '今日奖励已领取（或已完成）');
        return;
      }

      const redeemUrl = findRedeemUrl(doc1);
      if (!redeemUrl) {
        if (CFG.notify) notify('V2EX 签到', '未找到领取按钮/链接（可能结构变更）');
        return;
      }

      const html2 = await fetchText(redeemUrl);
      const doc2 = parseHtml(html2);

      if (alreadyRedeemed(doc2) || /奖励/.test(doc2.body?.innerText || '')) {
        if (CFG.notify) notify('V2EX 签到', '领取成功 ✅');
      } else {
        if (CFG.notify) notify('V2EX 签到', '已发起领取，请打开 /mission/daily 确认');
      }
    }

    function boot() {
      window.addEventListener('load', () => {
        setTimeout(() => {
          run().catch(err => {
            GM_setValue(CFG.storeKey, '');
            if (CFG.notify) notify('V2EX 签到', `失败：${err?.message || err}`);
          });
        }, 800);
      });
    }

    return { boot };
  })();

  // =========================
  // 3) 功能B：Base64 自动解码
  // =========================
  const B64 = (() => {
    const CFG = {
      MIN_LEN: 8,
      TARGET_SELECTORS: ['.topic_content', '.reply_content'],
      EXCLUDE_LIST: [
        'boss', 'bilibili', 'Bilibili', 'Encrypto', 'encrypto',
        'Window10', 'airpords', 'Windows7',
      ],
    };

    const BASE64_RE = /[A-Za-z0-9+/=]+/g;

    // ── 内容类型判断 ──────────────────────────────────────────
    function detectType(s) {
      if (/^https?:\/\//i.test(s)) return 'url';
      try { JSON.parse(s); return 'json'; } catch (_) {}
      return 'text';
    }

    // ── 解码（与原版逻辑一致）────────────────────────────────
    function customEscape(str) {
      return str.replace(
        /[^a-zA-Z0-9_.!~*'()-]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
      );
    }

    function tryDecode(text) {
      if (text.length % 4 !== 0) return null;
      if (text.length <= CFG.MIN_LEN) return null;
      if (CFG.EXCLUDE_LIST.includes(text)) return null;
      if (text.includes('=')) {
        const pi = text.indexOf('=');
        if (pi !== text.length - 1 && pi !== text.length - 2) return null;
      }
      try {
        const d = decodeURIComponent(customEscape(window.atob(text)));
        if (!/[A-Za-z0-9一-鿿]/.test(d)) return null;
        return d;
      } catch (_) { return null; }
    }

    // ── 构建替换节点 ──────────────────────────────────────────
    //
    // URL  → <span><span class="v2-b64-mark">b64</span><a href="...">decoded</a></span>
    // text → <span><span class="v2-b64-mark">b64</span><span class="v2-b64-plain" title="...">decoded</span></span>
    // JSON → 同 text，title 附加格式化 JSON
    //
    // 返回 null 表示不应替换（URL 格式验证失败等）
    //
    function makeReplacement(raw, decoded) {
      const type = detectType(decoded);

      const wrap = document.createElement('span');
      wrap.className = 'v2-b64-wrap';

      if (type === 'url') {
        // 用 URL 构造函数做严格校验
        let href;
        try {
          const u = new URL(decoded);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
          href = u.href;
        } catch (_) { return null; }

        const a = document.createElement('a');
        a.className = 'v2-b64-link';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        a.title = href;           // 鼠标悬停显示完整 URL（浏览器状态栏也会显示）
        a.textContent = decoded;
        wrap.appendChild(a);

      } else {
        // text / json：显示解码内容，title 提示原始 base64
        let titleStr = `base64 解码\n原文：${raw}`;
        if (type === 'json') {
          try {
            titleStr += `\n\n${JSON.stringify(JSON.parse(decoded), null, 2)}`;
          } catch (_) {}
        }

        const span = document.createElement('span');
        span.className = 'v2-b64-plain';
        span.textContent = decoded;
        span.title = titleStr;
        wrap.appendChild(span);
      }

      // 来源角标：插到最前面（左侧）
      const mark = document.createElement('span');
      mark.className = 'v2-b64-mark';
      mark.textContent = 'b64';
      mark.title = `由 base64 解码\n原文：${raw}`;
      wrap.prepend(mark);

      return wrap;
    }

    // ── 扫描单个内容块 ────────────────────────────────────────
    function processContent(contentEl) {
      if (!contentEl || contentEl.dataset.v2b64scanned === '1') return;

      const excludeTextList = [
        ...contentEl.getElementsByTagName('a'),
        ...contentEl.getElementsByTagName('img'),
      ].map((el) => el.outerHTML);

      const walker = document.createTreeWalker(
        contentEl,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (!node.nodeValue || node.nodeValue.length <= CFG.MIN_LEN) return NodeFilter.FILTER_REJECT;
            const p = node.parentElement;
            if (p.closest('.v2-b64-wrap')) return NodeFilter.FILTER_REJECT;
            if (p.closest('a, img'))       return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );

      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);

      nodes.forEach((node) => {
        const text = node.nodeValue;
        let last = 0;
        const frag = document.createDocumentFragment();
        let changed = false;

        BASE64_RE.lastIndex = 0;
        let m;
        while ((m = BASE64_RE.exec(text)) !== null) {
          const candidate = m[0];

          if (excludeTextList.some((ex) => ex.includes(candidate))) continue;

          const decoded = tryDecode(candidate);
          if (!decoded) continue;

          const replacement = makeReplacement(candidate, decoded);
          if (!replacement) continue;   // URL 验证失败，跳过

          changed = true;
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          frag.appendChild(replacement);
          last = m.index + candidate.length;
        }

        if (changed) {
          frag.appendChild(document.createTextNode(text.slice(last)));
          node.parentNode.replaceChild(frag, node);
        }
      });

      contentEl.dataset.v2b64scanned = '1';
    }

    // ── 批量扫描 + MutationObserver 监听动态内容 ─────────────
    function scanAll() {
      for (const sel of CFG.TARGET_SELECTORS) {
        document.querySelectorAll(sel).forEach(processContent);
      }
    }

    let scheduled = false;
    const scheduleScan = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => { scheduled = false; scanAll(); }, 60);
    };

    function boot() {
      if (!isTopicPage()) return;
      scanAll();
      const root = document.querySelector('#Main') || document.body;
      new MutationObserver((mutations) => {
        for (const mut of mutations) {
          if (mut.type === 'childList' && (mut.addedNodes?.length || mut.removedNodes?.length)) {
            scheduleScan();
            break;
          }
        }
      }).observe(root, { childList: true, subtree: true });
    }

    return { boot };
  })();

  // =========================
  // 4) 功能C：楼层树 + 多页加载
  // =========================
  const ThreadTree = (() => {
    function parseReplyCell(cell, idx) {
      if (!cell || !cell.id || !cell.id.startsWith('r_')) return null;

      const replyId = cell.id.replace('r_', '');
      const contentEl = cell.querySelector('.reply_content');
      const authorEl = cell.querySelector('strong a');
      const floorEl = cell.querySelector('.no');
      const avatarEl = cell.querySelector('img.avatar');

      if (!contentEl || !authorEl || !floorEl) return null;

      const memberName = authorEl.innerText;
      const memberLink = authorEl.href;
      const memberAvatar = avatarEl ? avatarEl.src : '';
      const content = contentEl.innerText;
      const floor = floorEl.innerText;
      const floorNum = parseInt(floor, 10);
      const likes = parseInt(cell.querySelector('span.small')?.innerText || '0', 10);

      const memberNameMatches = Array.from(content.matchAll(/@([a-zA-Z0-9]+)/g));
      const refMemberNames = memberNameMatches.length > 0
        ? memberNameMatches.map(([, name]) => name)
        : undefined;

      const floorMatches = Array.from(content.matchAll(/#(\d+)/g));
      const refFloors = floorMatches.length > 0
        ? floorMatches.map(([, f]) => f)
        : undefined;

      return {
        element: cell,
        id: replyId,
        index: idx,
        memberName,
        memberLink,
        memberAvatar,
        content,
        floor,
        floorNum,
        likes,
        refMemberNames,
        refFloors,
        children: [],
      };
    }

    function extractRepliesFromDoc(doc) {
      const cells = Array.from(doc.querySelectorAll('div.cell[id^="r_"]'));
      return cells.map((cell, idx) => parseReplyCell(cell, idx)).filter(Boolean);
    }

    function inferParent(reply, allReplies) {
      const { refMemberNames, refFloors, index, floorNum } = reply;

      if (!refMemberNames || refMemberNames.length === 0) return null;

      for (let j = index - 1; j >= 0; j--) {
        const r = allReplies[j];
        if (r.memberName.toLowerCase() === refMemberNames[0].toLowerCase()) {
          let parentIdx = j;

          const firstRefFloor = refFloors?.[0];
          if (firstRefFloor && parseInt(firstRefFloor, 10) !== r.floorNum) {
            const targetIdx = allReplies.slice(0, j).findIndex(
              (data) => data.floorNum === parseInt(firstRefFloor, 10) &&
                        data.memberName.toLowerCase() === refMemberNames[0].toLowerCase()
            );
            if (targetIdx >= 0) {
              parentIdx = targetIdx;
            }
          }

          if (allReplies[parentIdx].floorNum < floorNum) {
            return allReplies[parentIdx];
          }
          return null;
        }
      }

      if (refFloors && refFloors.length > 0) {
        const targetFloor = parseInt(refFloors[0], 10);
        if (targetFloor < floorNum) {
          return allReplies.find(r => r.floorNum === targetFloor);
        }
      }

      return null;
    }

    function renderTree(flatReplies, container) {
      const roots = [];
      flatReplies.forEach(r => { r.children = []; });

      flatReplies.forEach(r => {
        const parent = inferParent(r, flatReplies);
        if (parent) parent.children.push(r);
        else roots.push(r);
      });

      const fragment = document.createDocumentFragment();

      function appendNode(reply, parentContainer) {
        const wrapper = document.createElement('div');
        wrapper.className = 'reply-wrapper';
        reply.element.classList.remove('inner');
        wrapper.appendChild(reply.element);

        if (reply.children.length > 0) {
          const childCount = reply.children.length;
          const childrenContainer = document.createElement('div');
          childrenContainer.className = 'reply-children collapsible';
          reply.children.forEach(child => appendNode(child, childrenContainer));

          // 折叠指示器（collapsed 时显示在 children 之后）
          const collapsedHint = document.createElement('div');
          collapsedHint.className = 'reply-collapsed-hint';
          collapsedHint.textContent = `▶ 展开 ${childCount} 条回复`;

          // 点击缩进线 → 折叠
          childrenContainer.addEventListener('click', (e) => {
            // 仅响应直接点击缩进线区域（左侧 16px 内），不影响子回复交互
            const rect = childrenContainer.getBoundingClientRect();
            if (e.clientX - rect.left > 20) return;
            e.stopPropagation();
            toggleCollapse(childrenContainer, collapsedHint, childCount);
          });

          // 点击折叠提示 → 展开
          collapsedHint.addEventListener('click', () => {
            toggleCollapse(childrenContainer, collapsedHint, childCount);
          });

          wrapper.appendChild(childrenContainer);
          wrapper.appendChild(collapsedHint);
        }

        parentContainer.appendChild(wrapper);
      }

      function toggleCollapse(childrenContainer, hint, count) {
        const isNowCollapsed = childrenContainer.classList.toggle('is-collapsed');
        hint.textContent = isNowCollapsed
          ? `▶ 展开 ${count} 条回复`
          : `▼ 折叠 ${count} 条回复`;
        // 展开后重置 hint 文字（短暂延迟后恢复默认，不常驻占位）
        if (!isNowCollapsed) {
          setTimeout(() => {
            hint.textContent = `▶ 展开 ${count} 条回复`;
          }, 1800);
        }
      }

      roots.forEach(r => appendNode(r, fragment));
      container.innerHTML = '';
      container.appendChild(fragment);
    }

    // 返回新回复数量，供 init 显示计数条
    function handleReadStatus(topicId, replies) {
      const STORAGE_KEY = `v2_last_read_${topicId}`;
      const storedValue = localStorage.getItem(STORAGE_KEY);
      let maxFloor = 0;
      for (const r of replies) if (r.floorNum > maxFloor) maxFloor = r.floorNum;

      if (storedValue === null) {
        localStorage.setItem(STORAGE_KEY, String(maxFloor));
        return 0;
      }

      const lastReadFloor = parseInt(storedValue, 10) || 0;
      let newCount = 0;

      for (const r of replies) {
        if (r.floorNum > lastReadFloor) {
          newCount++;
          r.element.classList.add('reply-new');

          // ── 改动：NEW badge 插到 <strong> 之后（strong 的下一个兄弟位置）
          //    而非 prepend 到 strong 内部，避免在加粗文字中显示奇怪
          const strongEl = r.element.querySelector('strong');
          if (strongEl && !r.element.querySelector('.new-badge')) {
            const badge = document.createElement('span');
            badge.className = 'new-badge';
            badge.textContent = 'NEW';
            badge.title = '未读新回复';
            // insertAdjacentElement 'afterend' = strong 元素之后、作为兄弟节点
            strongEl.insertAdjacentElement('afterend', badge);
          }
        }
      }

      localStorage.setItem(STORAGE_KEY, String(maxFloor));
      return newCount;
    }

    async function init() {
      if (!isTopicPage()) return;
      const topicId = location.pathname.match(/\/t\/(\d+)/)?.[1];
      if (!topicId) return;

      const replyBox = Array.from(document.querySelectorAll('.box')).find(b => b.querySelector('div[id^="r_"]'));
      if (!replyBox) return;

      const loadingBar = document.createElement('div');
      loadingBar.id = 'v2ex-loading-bar';
      loadingBar.innerText = '加载中...';
      replyBox.parentNode.insertBefore(loadingBar, replyBox);

      let totalPages = 1;
      const pageInput = document.querySelector('.page_input');
      if (pageInput) {
        totalPages = parseInt(pageInput.max, 10) || 1;
      } else {
        const pageLinks = document.querySelectorAll('a.page_normal');
        if (pageLinks.length > 0) {
          totalPages = parseInt(pageLinks[pageLinks.length - 1].innerText, 10) || 1;
        }
      }

      let allReplies = [];
      allReplies = allReplies.concat(extractRepliesFromDoc(document));

      if (totalPages > 1) {
        const currentP = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
        const fetchPromises = [];
        for (let p = 1; p <= totalPages; p++) {
          if (p === currentP) continue;
          fetchPromises.push(
            fetch(`${location.pathname}?p=${p}`)
              .then(res => res.text())
              .then(html => {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                return extractRepliesFromDoc(doc);
              })
              .catch(() => [])
          );
        }
        const otherPagesReplies = await Promise.all(fetchPromises);
        otherPagesReplies.forEach(list => { allReplies = allReplies.concat(list); });
      }

      allReplies.sort((a, b) => a.floorNum - b.floorNum);
      allReplies.forEach((reply, i) => { reply.index = i; });
      document.querySelectorAll('.page_input, .page_current, .page_normal')
        .forEach(el => el.closest('div')?.remove());

      renderTree(allReplies, replyBox);
      const newCount = handleReadStatus(topicId, allReplies);

      loadingBar.remove();
      document.querySelectorAll('a[name="last_page"]').forEach(e => e.remove());

      // ── 新回复计数提示条（有新回复时才显示）
      if (newCount > 0) {
        const bar = document.createElement('div');
        bar.id = 'v2ex-new-count-bar';
        bar.innerHTML = `
          <span class="ncb-dot"></span>
          <span>有 <strong>${newCount}</strong> 条新回复</span>
          <span class="ncb-hint">j / k 键跳转</span>
        `;
        replyBox.parentNode.insertBefore(bar, replyBox);
      }
    }

    function boot() { init().catch(err => log('ThreadTree error:', err)); }
    return { boot };
  })();

  // =========================
  // 5) 功能D：高赞回复阅览室
  // =========================
  const HotRoom = (() => {
    function extractComments() {
      const comments = [];
      const cells = document.querySelectorAll('.cell[id^="r_"]');
      cells.forEach((cell) => {
        try {
          const smallFades = cell.querySelectorAll('.small.fade');
          let likes = 0;

          for (const span of smallFades) {
            const text = span.innerText || '';
            const m1 = text.match(/(?:♥|❤️)\s*(\d+)/);
            if (m1) { likes = parseInt(m1[1], 10); break; }
            const heartImg = span.querySelector('img[alt="❤️"]');
            if (heartImg && text.trim().length > 0) {
              likes = parseInt(text.trim(), 10);
              break;
            }
          }

          if (likes > 0) {
            comments.push({
              id: cell.id,
              likes,
              avatar: cell.querySelector('img.avatar')?.src || '',
              username: cell.querySelector('strong > a')?.innerText || 'Unknown',
              userUrl: cell.querySelector('strong > a')?.href || '#',
              time: cell.querySelector('.ago')?.innerText || '',
              contentHtml: cell.querySelector('.reply_content')?.innerHTML || '',
              floor: cell.querySelector('.no')?.innerText || '#',
            });
          }
        } catch (_) {}
      });
      return comments.sort((a, b) => b.likes - a.likes);
    }

    function buildUI(comments) {
      const old = document.getElementById('hot-overlay');
      if (old) old.remove();

      const overlay = document.createElement('div');
      overlay.id = 'hot-overlay';

      const container = document.createElement('div');
      container.className = 'hot-container';

      if (!comments.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center;padding:40px;color:#ccc;font-size:13px;';
        empty.textContent = '暂无高赞回复';
        container.appendChild(empty);
      } else {
        comments.forEach((c, index) => {
          let rankClass = 'rank-normal';
          if (index === 0) rankClass = 'rank-1';
          else if (index === 1) rankClass = 'rank-2';
          else if (index === 2) rankClass = 'rank-3';

          const card = document.createElement('div');
          card.className = `hot-card ${rankClass}`;

          const header = document.createElement('div');
          header.className = 'card-header-row';

          const avatar = document.createElement('img');
          avatar.className = 'user-avatar';
          avatar.src = c.avatar;
          header.appendChild(avatar);

          const user = document.createElement('a');
          user.className = 'user-name';
          user.href = c.userUrl;
          user.target = '_blank';
          user.rel = 'noreferrer noopener';
          user.textContent = c.username;
          header.appendChild(user);

          const floor = document.createElement('div');
          floor.className = 'floor-tag';
          floor.title = '跳转';
          floor.textContent = c.floor;
          floor.addEventListener('click', () => {
            closeOverlay(overlay);
            setTimeout(() => {
              const el = document.getElementById(c.id);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 250);
          });
          header.appendChild(floor);

          const time = document.createElement('span');
          time.className = 'time-tag';
          time.textContent = c.time;
          header.appendChild(time);

          const likes = document.createElement('div');
          likes.className = 'likes-pill';
          likes.textContent = `♥ ${c.likes}`;
          header.appendChild(likes);

          const content = document.createElement('div');
          content.className = 'card-content';
          content.innerHTML = c.contentHtml;

          card.appendChild(header);
          card.appendChild(content);
          container.appendChild(card);
        });
      }

      overlay.appendChild(container);
      document.body.appendChild(overlay);

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay(overlay);
      });
      const onKey = (e) => {
        if (e.key === 'Escape') closeOverlay(overlay);
      };
      document.addEventListener('keydown', onKey);
      overlay._cleanup = () => document.removeEventListener('keydown', onKey);
      return overlay;
    }

    function closeOverlay(overlay) {
      if (!overlay) return;
      overlay.classList.remove('active');
      setTimeout(() => {
        if (!overlay.classList.contains('active')) {
          overlay._cleanup?.();
          overlay.remove();
        }
      }, 200);
    }

    function initButton() {
      if (!isTopicPage()) return;
      const topicHeader = document.querySelector('#Main .header h1');
      const boxHeader = document.querySelector('#Main .box .header');
      const target = topicHeader || boxHeader;

      if (target && !document.getElementById('v2ex-hot-btn')) {
        const btn = document.createElement('span');
        btn.id = 'v2ex-hot-btn';
        btn.innerText = '高赞';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const overlay = buildUI(extractComments());
          requestAnimationFrame(() => overlay.classList.add('active'));
        });
        target.appendChild(btn);
      }
    }

    function boot() {
      if (!isTopicPage()) return;
      setTimeout(initButton, 500);
    }

    return { boot };
  })();

  // =========================
  // 6) 功能E：j/k 键盘导航新回复
  // =========================
  const NavKeys = (() => {
    const POLL_INTERVAL = 200;
    const POLL_TIMEOUT  = 8000;
    const SCROLL_OFFSET_RATIO = 0.22;

    let newReplies = [];
    let curIndex   = -1;
    let hudTimer   = null;

    function getHud() {
      let hud = document.getElementById('v2ex-nav-hud');
      if (!hud) {
        hud = document.createElement('div');
        hud.id = 'v2ex-nav-hud';
        document.body.appendChild(hud);
      }
      return hud;
    }

    function showHud(index, total, direction) {
      const hud = getHud();
      const arrow = direction === 'next' ? '↓' : '↑';
      hud.innerHTML = `
        <span class="hud-arrow">${arrow}</span>
        <span class="hud-label">NEW</span>
        <span class="hud-count">${index + 1}<span class="hud-sep"> / </span>${total}</span>
        <span class="hud-hint">j↓ k↑</span>
      `;
      hud.classList.add('visible');

      clearTimeout(hudTimer);
      hudTimer = setTimeout(() => hud.classList.remove('visible'), 2200);
    }

    function scrollToReply(el) {
      const targetTop = el.getBoundingClientRect().top
        + window.scrollY
        - window.innerHeight * SCROLL_OFFSET_RATIO;
      window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
    }

    function setActive(el) {
      document.querySelectorAll('.reply-nav-active').forEach(e => {
        e.classList.remove('reply-nav-active');
      });
      if (el) {
        const wrapper = el.closest('.reply-wrapper') || el;
        wrapper.classList.add('reply-nav-active');
      }
    }

    function refreshList() {
      newReplies = Array.from(document.querySelectorAll('.reply-new'));
    }

    function navigate(direction) {
      refreshList();
      if (!newReplies.length) return;

      if (direction === 'next') {
        curIndex = Math.min(curIndex + 1, newReplies.length - 1);
      } else {
        curIndex = Math.max(curIndex - 1, 0);
      }

      const target = newReplies[curIndex];
      setActive(target);
      scrollToReply(target);
      showHud(curIndex, newReplies.length, direction);
    }

    function onKeyDown(e) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.getElementById('hot-overlay')?.classList.contains('active')) return;

      if (e.key === 'j') {
        e.preventDefault();
        navigate('next');
      } else if (e.key === 'k') {
        e.preventDefault();
        navigate('prev');
      }
    }

    function waitAndBoot() {
      const start = Date.now();
      const timer = setInterval(() => {
        const found = document.querySelectorAll('.reply-new').length > 0;
        const timedOut = Date.now() - start > POLL_TIMEOUT;

        if (found || timedOut) {
          clearInterval(timer);
          if (found) {
            refreshList();
            document.addEventListener('keydown', onKeyDown);
            log(`NavKeys ready: ${newReplies.length} new replies`);
          }
        }
      }, POLL_INTERVAL);
    }

    function boot() {
      if (!isTopicPage()) return;
      waitAndBoot();
    }

    return { boot };
  })();

  // =========================
  // 7) 功能F：Imgur 图片代理
  // =========================
  const ImgurProxy = (() => {
    function processImage(img) {
      const src = img.getAttribute('src');
      if (!src) return;

      if (src.includes('imgur.com') && !src.includes('external-content.duckduckgo.com')) {
        let fullUrl = src;
        if (src.startsWith('//')) {
          fullUrl = 'https:' + src;
        } else if (!src.startsWith('http')) {
          fullUrl = 'https://' + src;
        }

        const proxyUrl = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(fullUrl)}&f=1&nofb=1`;
        img.setAttribute('src', proxyUrl);
        img.dataset.proxied = '1';

        const parent = img.parentElement;
        if (parent && parent.tagName.toLowerCase() === 'a') {
          const href = parent.getAttribute('href');
          if (href && href.includes('imgur.com') && !href.includes('external-content.duckduckgo.com')) {
            let fullHref = href;
            if (href.startsWith('//')) fullHref = 'https:' + href;
            const proxyHref = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(fullHref)}&f=1&nofb=1`;
            parent.setAttribute('href', proxyHref);
          }
        }
      }
    }

    function scanAll() {
      document.querySelectorAll('img[src*="imgur.com"]').forEach(processImage);
    }

    function boot() {
      scanAll();

      const observer = new MutationObserver((mutations) => {
        let shouldScan = false;
        for (const m of mutations) {
          if (m.addedNodes && m.addedNodes.length > 0) {
            shouldScan = true;
            break;
          }
        }
        if (shouldScan) scanAll();
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }

    return { boot };
  })();

  // =========================
  // 8) 启动
  // =========================
  Daily.boot();

  if (isTopicPage()) {
    ThreadTree.boot();
    B64.boot();
    HotRoom.boot();
    NavKeys.boot();
    ImgurProxy.boot();
  }
})();
