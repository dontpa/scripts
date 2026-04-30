// ==UserScript==
// @name         V2EX Tweaks
// @namespace    https://tampermonkey.net/
// @version      2.2.0
// @description  V2EX 日常增强：回复嵌套树 + 合并分页；未读新回复标记 + j/k 跳转；高赞阅览室（图片 Lightbox）；Base64 解码（熵过滤）；折叠状态持久化；悬停引用预览；多页加载失败重试；每日签到；Imgur 代理。
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
  // 0) 统一配置
  // =========================
  const CONFIG = {
    daily: {
      page: '/mission/daily',
      delayMinMs: 1500,
      delayMaxMs: 3800,
      storeKey: 'v2ex_daily_check_ymd_v2',
      notify: true,
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

  function ymdLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function isTopicPage() {
    return /^\/t\/\d+/.test(location.pathname);
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
  GM_addStyle(`
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
    .new-badge {
      display: inline-block;
      font-size: 9px; font-weight: 700;
      color: var(--new-accent); background: transparent;
      border: 1px solid rgba(74,122,240,0.45); border-radius: 3px;
      padding: 0 3px; line-height: 14px; height: 14px;
      margin-left: 5px; margin-right: 2px;
      vertical-align: middle; letter-spacing: 0.5px;
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
    .v2-b64-wrap { word-break: break-all; }
    .v2-b64-link { color: #4a7af0 !important; text-decoration: none; }
    .v2-b64-link:hover { color: #3060d8 !important; text-decoration: underline; }
    .v2-b64-plain {
      text-decoration: underline; text-decoration-style: dotted;
      text-decoration-color: #8aa8f8; text-underline-offset: 2px; cursor: help;
    }
    .v2-b64-mark {
      display: inline-block;
      font-size: 9px; font-weight: 700; font-style: normal;
      color: #8aa8f8; border: 1px solid #d0defe; border-radius: 2px;
      padding: 0 3px; line-height: 13px;
      vertical-align: middle; position: relative; top: -1px;
      margin-right: 4px; cursor: default; user-select: none;
      text-decoration: none !important; letter-spacing: 0.2px;
    }

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
  `);

  // =========================
  // 3) 功能A：每日自动签到
  // =========================
  const Daily = (() => {
    function isLoggedIn() {
      return !!document.querySelector('a[href="/signout"]') || !document.querySelector('a[href="/signin"]');
    }
    async function fetchText(url) {
      const res = await fetch(url, { method: 'GET', credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    }
    function parseHtml(html) { return new DOMParser().parseFromString(html, 'text/html'); }
    function alreadyRedeemed(doc) {
      return /已领取|已经领取|每日登录奖励已领取|redeemed|already redeemed|已完成/.test(doc.body?.innerText || '');
    }
    function findRedeemUrl(doc) {
      const a = doc.querySelector('a[href^="/mission/daily/redeem"]');
      if (a?.getAttribute('href')) return a.getAttribute('href');
      const btn = doc.querySelector('input[type="button"][onclick*="redeem"], input[value^="领取"][onclick]');
      if (btn) { const m = (btn.getAttribute('onclick') || '').match(/'([^']+)'/); if (m?.[1]) return m[1]; }
      const any = [...doc.querySelectorAll('[onclick]')].find(el => (el.getAttribute('onclick') || '').includes('/mission/daily/redeem'));
      if (any) { const m = (any.getAttribute('onclick') || '').match(/'([^']+)'/); if (m?.[1]) return m[1]; }
      return null;
    }
    async function run() {
      const { notify: doNotify, page, delayMinMs, delayMaxMs, storeKey } = CONFIG.daily;
      if (!doNotify || !isLoggedIn()) return;
      const today = ymdLocal();
      if (GM_getValue(storeKey, '') === today) return;
      GM_setValue(storeKey, today);
      await sleep(randInt(delayMinMs, delayMaxMs));
      const doc1 = parseHtml(await fetchText(page));
      if (alreadyRedeemed(doc1)) { notify('V2EX 签到', '今日奖励已领取'); return; }
      const redeemUrl = findRedeemUrl(doc1);
      if (!redeemUrl) { notify('V2EX 签到', '未找到领取按钮（可能结构变更）'); return; }
      const doc2 = parseHtml(await fetchText(redeemUrl));
      notify('V2EX 签到', (alreadyRedeemed(doc2) || /奖励/.test(doc2.body?.innerText || '')) ? '领取成功 ✅' : '已发起领取，请确认');
    }
    function boot() {
      window.addEventListener('load', () => setTimeout(() => {
        run().catch(err => {
          GM_setValue(CONFIG.daily.storeKey, '');
          notify('V2EX 签到', `失败：${err?.message || err}`);
        });
      }, 800));
    }
    return { boot };
  })();

  // =========================
  // 4) 功能B：Base64 解码（含 Shannon 熵过滤）
  // =========================
  const B64 = (() => {
    const BASE64_RE = /[A-Za-z0-9+/=]+/g;

    function detectType(s) {
      if (/^https?:\/\//i.test(s)) return 'url';
      try { JSON.parse(s); return 'json'; } catch (_) {}
      return 'text';
    }
    function customEscape(str) {
      return str.replace(/[^a-zA-Z0-9_.!~*'()-]/g, c =>
        `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
      );
    }
    function tryDecode(text) {
      const { minLen, excludeList, entropyThreshold } = CONFIG.b64;
      if (text.length % 4 !== 0) return null;
      if (text.length <= minLen) return null;
      if (excludeList.includes(text)) return null;
      if (text.includes('=')) {
        const pi = text.indexOf('=');
        if (pi !== text.length - 1 && pi !== text.length - 2) return null;
      }
      try {
        const d = decodeURIComponent(customEscape(window.atob(text)));
        if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(d)) return null;
        // 熵过滤：排除低熵解码（乱码、单调重复字符等误判）
        if (shannonEntropy(d) < entropyThreshold) return null;
        return d;
      } catch (_) { return null; }
    }
    function makeReplacement(raw, decoded) {
      const type = detectType(decoded);
      const wrap = document.createElement('span');
      wrap.className = 'v2-b64-wrap';
      if (type === 'url') {
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
        let titleStr = `base64 解码\n原文：${raw}`;
        if (type === 'json') {
          try { titleStr += `\n\n${JSON.stringify(JSON.parse(decoded), null, 2)}`; } catch (_) {}
        }
        const span = document.createElement('span');
        span.className = 'v2-b64-plain';
        span.textContent = decoded; span.title = titleStr;
        wrap.appendChild(span);
      }
      const mark = document.createElement('span');
      mark.className = 'v2-b64-mark'; mark.textContent = 'b64';
      mark.title = `由 base64 解码\n原文：${raw}`;
      wrap.prepend(mark);
      return wrap;
    }
    function processContent(contentEl) {
      if (!contentEl || contentEl.dataset.v2b64scanned === '1') return;
      const excludeTextList = [
        ...contentEl.getElementsByTagName('a'),
        ...contentEl.getElementsByTagName('img'),
      ].map(el => el.outerHTML);

      const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || node.nodeValue.length <= CONFIG.b64.minLen) return NodeFilter.FILTER_REJECT;
          const p = node.parentElement;
          // 跳过已处理的 b64 包裹和 hover 预览引用标注
          if (p.closest('.v2-b64-wrap, .v2-ref-link')) return NodeFilter.FILTER_REJECT;
          if (p.closest('a, img')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(node => {
        const text = node.nodeValue;
        let last = 0;
        const frag = document.createDocumentFragment();
        let changed = false;
        BASE64_RE.lastIndex = 0;
        let m;
        while ((m = BASE64_RE.exec(text)) !== null) {
          const candidate = m[0];
          if (excludeTextList.some(ex => ex.includes(candidate))) continue;
          const decoded = tryDecode(candidate);
          if (!decoded) continue;
          const replacement = makeReplacement(candidate, decoded);
          if (!replacement) continue;
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
    function scanAll() {
      for (const sel of CONFIG.b64.targetSelectors) {
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
      new MutationObserver(mutations => {
        for (const mut of mutations) {
          if (mut.type === 'childList' && (mut.addedNodes?.length || mut.removedNodes?.length)) {
            scheduleScan(); break;
          }
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

      const memberName = authorEl.innerText;
      const content    = contentEl.innerText;
      const floor      = floorEl.innerText;
      const floorNum   = parseInt(floor, 10);
      const likes      = parseInt(cell.querySelector('span.small')?.innerText || '0', 10);
      const refMemberNames = [...content.matchAll(/@([a-zA-Z0-9]+)/g)].map(([, n]) => n);
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

    // ── 父节点推断，O(1) 查找 ──
    function inferParent(reply, { floorMap, nameMap }) {
      const { refMemberNames, refFloors, index, floorNum } = reply;
      if (!refMemberNames?.length) return null;

      const targetName = refMemberNames[0].toLowerCase();
      const candidates = nameMap.get(targetName);

      if (candidates?.length) {
        const firstRefFloor = refFloors?.[0] ? parseInt(refFloors[0], 10) : null;
        if (firstRefFloor !== null) {
          const exact = floorMap.get(firstRefFloor);
          if (exact && exact.memberName.toLowerCase() === targetName && exact.floorNum < floorNum) return exact;
        }
        let best = null;
        for (const c of candidates) {
          if (c.index < index && c.floorNum < floorNum) {
            if (!best || c.index > best.index) best = c;
          }
        }
        return best;
      }

      if (refFloors?.length) {
        const targetFloor = parseInt(refFloors[0], 10);
        if (targetFloor < floorNum) return floorMap.get(targetFloor) ?? null;
      }
      return null;
    }

    // ── 折叠持久化（sessionStorage）──
    function collapseKey(topicId)    { return `${CONFIG.threadTree.collapseKeyPrefix}${topicId}`; }
    function getCollapsedSet(topicId) {
      try { return new Set(JSON.parse(sessionStorage.getItem(collapseKey(topicId)) || '[]')); }
      catch { return new Set(); }
    }
    function saveCollapsedSet(topicId, set) {
      sessionStorage.setItem(collapseKey(topicId), JSON.stringify([...set]));
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

      function toggleCollapse(childrenEl, hint, count, replyId) {
        const nowCollapsed = childrenEl.classList.toggle('is-collapsed');
        const set = getCollapsedSet(topicId);
        if (nowCollapsed) set.add(replyId); else set.delete(replyId);
        saveCollapsedSet(topicId, set);
        hint.textContent = nowCollapsed ? `▶ 展开 ${count} 条回复` : `▼ 折叠 ${count} 条回复`;
        if (!nowCollapsed) setTimeout(() => { hint.textContent = `▶ 展开 ${count} 条回复`; }, 1800);
      }

      function appendNode(reply, parentEl) {
        const wrapper = document.createElement('div');
        wrapper.className = 'reply-wrapper';
        wrapper.dataset.replyId = reply.id;
        reply.element.classList.remove('inner');
        wrapper.appendChild(reply.element);

        if (reply.children.length > 0) {
          const count      = reply.children.length;
          const childrenEl = document.createElement('div');
          childrenEl.className = 'reply-children collapsible';
          reply.children.forEach(child => appendNode(child, childrenEl));

          const hint = document.createElement('div');
          hint.className = 'reply-collapsed-hint';
          hint.textContent = `▶ 展开 ${count} 条回复`;

          // 恢复折叠状态
          if (collapsedSet.has(reply.id)) childrenEl.classList.add('is-collapsed');

          childrenEl.addEventListener('click', e => {
            const rect = childrenEl.getBoundingClientRect();
            if (e.clientX - rect.left > 20) return;
            e.stopPropagation();
            toggleCollapse(childrenEl, hint, count, reply.id);
          });
          hint.addEventListener('click', () => toggleCollapse(childrenEl, hint, count, reply.id));

          wrapper.appendChild(childrenEl);
          wrapper.appendChild(hint);
        }
        parentEl.appendChild(wrapper);
      }

      roots.forEach(r => appendNode(r, fragment));
      container.innerHTML = '';
      container.appendChild(fragment);
    }

    // ── 未读标记 ──
    function handleReadStatus(topicId, replies) {
      const key    = `${CONFIG.threadTree.readKeyPrefix}${topicId}`;
      const stored = localStorage.getItem(key);
      let maxFloor = 0;
      for (const r of replies) if (r.floorNum > maxFloor) maxFloor = r.floorNum;

      if (stored === null) { localStorage.setItem(key, String(maxFloor)); return 0; }

      const lastReadFloor = parseInt(stored, 10) || 0;
      let newCount = 0;
      for (const r of replies) {
        if (r.floorNum > lastReadFloor) {
          newCount++;
          r.element.classList.add('reply-new');
          const strongEl = r.element.querySelector('strong');
          if (strongEl && !r.element.querySelector('.new-badge')) {
            const badge = document.createElement('span');
            badge.className = 'new-badge'; badge.textContent = 'NEW'; badge.title = '未读新回复';
            strongEl.insertAdjacentElement('afterend', badge);
          }
        }
      }
      localStorage.setItem(key, String(maxFloor));
      return newCount;
    }

    // ── 悬停引用预览（在 B64 完成后运行，延迟 150ms）──
    function initHoverPreview(allReplies, { floorMap, nameMap }) {
      // 非全局：用于 acceptNode 内的测试（无 lastIndex 副作用）
      const REF_TEST_RE = /@[a-zA-Z0-9]+|#\d+/;
      // 全局：用于 exec 循环
      const REF_EXEC_RE = /(@[a-zA-Z0-9]+|#\d+)/g;

      let card      = null;
      let hideTimer = null;

      function getCard() {
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
        const contentHtml = refReply.element.querySelector('.reply_content')?.innerHTML || refReply.content;
        c.innerHTML = `
          <div class="rp-header">
            <img class="rp-avatar" src="${refReply.memberAvatar}" />
            <span class="rp-name">${refReply.memberName}</span>
            <span class="rp-floor">#${refReply.floor}</span>
          </div>
          <div class="rp-content">${contentHtml}</div>
        `;
        const rect  = anchorEl.getBoundingClientRect();
        const cardW = 360;
        const cardH = 160;
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

      for (const reply of allReplies) {
        const contentEl = reply.element.querySelector('.reply_content');
        if (!contentEl) continue;

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
              const name  = token.slice(1).toLowerCase();
              const cands = nameMap.get(name);
              if (cands?.length) {
                for (let i = cands.length - 1; i >= 0; i--) {
                  if (cands[i].index < reply.index) { refReply = cands[i]; break; }
                }
              }
            } else if (token.startsWith('#')) {
              const floor = parseInt(token.slice(1), 10);
              const found = floorMap.get(floor) ?? null;
              refReply = (found && found.floorNum < reply.floorNum) ? found : null;
            }

            frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            if (refReply) {
              const span = document.createElement('span');
              span.className = 'v2-ref-link'; span.textContent = token;
              span.addEventListener('mouseenter', () => showCard(refReply, span));
              span.addEventListener('mouseleave', hideCard);
              frag.appendChild(span);
              changed = true;
            } else {
              frag.appendChild(document.createTextNode(token));
            }
            last = m.index + token.length;
          }

          if (changed) {
            frag.appendChild(document.createTextNode(text.slice(last)));
            node.parentNode.replaceChild(frag, node);
          }
        });
      }
    }

    // ── 主流程 ──
    async function init() {
      if (!isTopicPage()) return;
      const topicId = location.pathname.match(/\/t\/(\d+)/)?.[1];
      if (!topicId) return;

      const replyBox = Array.from(document.querySelectorAll('.box')).find(b => b.querySelector('div[id^="r_"]'));
      if (!replyBox) return;

      const loadingBar = document.createElement('div');
      loadingBar.id = 'v2ex-loading-bar'; loadingBar.innerText = '加载中...';
      replyBox.parentNode.insertBefore(loadingBar, replyBox);

      let totalPages = 1;
      const pageInput = document.querySelector('.page_input');
      if (pageInput) {
        totalPages = parseInt(pageInput.max, 10) || 1;
      } else {
        const pageLinks = document.querySelectorAll('a.page_normal');
        if (pageLinks.length > 0) totalPages = parseInt(pageLinks[pageLinks.length - 1].innerText, 10) || 1;
      }

      let allReplies = extractRepliesFromDoc(document);
      const currentP = parseInt(new URLSearchParams(location.search).get('p') || '1', 10);
      const failedPages = [];

      if (totalPages > 1) {
        const fetches = Array.from({ length: totalPages }, (_, i) => i + 1)
          .filter(p => p !== currentP)
          .map(p =>
            fetch(`${location.pathname}?p=${p}`)
              .then(r => r.text())
              .then(html => extractRepliesFromDoc(new DOMParser().parseFromString(html, 'text/html')))
              .catch(() => { failedPages.push(p); return []; })
          );
        const results = await Promise.all(fetches);
        results.forEach(list => allReplies.push(...list));
      }

      allReplies.sort((a, b) => a.floorNum - b.floorNum);
      allReplies.forEach((r, i) => { r.index = i; });
      document.querySelectorAll('.page_input, .page_current, .page_normal').forEach(el => el.closest('div')?.remove());

      // let 以便 doRetry 内可重新赋值
      let maps = buildLookupMaps(allReplies);
      renderTree(allReplies, maps, replyBox, topicId);

      const newCount = handleReadStatus(topicId, allReplies);
      loadingBar.remove();
      document.querySelectorAll('a[name="last_page"]').forEach(e => e.remove());

      if (newCount > 0) {
        const bar = document.createElement('div');
        bar.id = 'v2ex-new-count-bar';
        bar.innerHTML = `<span class="ncb-dot"></span><span>有 <strong>${newCount}</strong> 条新回复</span><span class="ncb-hint">j / k 键跳转</span>`;
        replyBox.parentNode.insertBefore(bar, replyBox);
      }

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

            const results = await Promise.all(
              pagesToRetry.map(p =>
                fetch(`${location.pathname}?p=${p}`)
                  .then(r => r.text())
                  .then(html => ({ p, replies: extractRepliesFromDoc(new DOMParser().parseFromString(html, 'text/html')) }))
                  .catch(() => ({ p, replies: null }))
              )
            );

            const stillFailed = results.filter(r => !r.replies).map(r => r.p);
            const newReplies   = results.filter(r =>  r.replies).flatMap(r => r.replies);

            if (newReplies.length > 0) {
              allReplies = [...allReplies, ...newReplies].sort((a, b) => a.floorNum - b.floorNum);
              allReplies.forEach((r, i) => { r.index = i; });
              maps = buildLookupMaps(allReplies);
              renderTree(allReplies, maps, replyBox, topicId);
              setTimeout(() => initHoverPreview(allReplies, maps), 150);
            }

            if (stillFailed.length > 0) {
              attachRetry(stillFailed); // 仍有失败页 → 重新挂载按钮
            } else {
              banner.remove();
            }
          });
        }
        attachRetry([...failedPages]);
      }

      // 悬停预览在 B64 完成后运行（B64 延迟 60ms，此处给 150ms 裕量）
      setTimeout(() => initHoverPreview(allReplies, maps), 150);
    }

    function boot() { init().catch(err => log('ThreadTree error:', err)); }
    return { boot };
  })();

  // =========================
  // 6) 功能D：高赞回复阅览室（含图片 Lightbox）
  // =========================
  const HotRoom = (() => {

    // ── Lightbox ──
    function openLightbox(src) {
      let lb = document.getElementById('v2ex-lightbox');
      if (!lb) {
        lb = document.createElement('div');
        lb.id = 'v2ex-lightbox';
        const img = document.createElement('img');
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
            const text = span.innerText || '';
            const m1 = text.match(/(?:♥|❤️)\s*(\d+)/);
            if (m1) { likes = parseInt(m1[1], 10); break; }
            if (span.querySelector('img[alt="❤️"]') && text.trim().length > 0) {
              likes = parseInt(text.trim(), 10); break;
            }
          }
          if (likes > 0) {
            comments.push({
              id: cell.id, likes,
              avatar:      cell.querySelector('img.avatar')?.src || '',
              username:    cell.querySelector('strong > a')?.innerText || 'Unknown',
              userUrl:     cell.querySelector('strong > a')?.href || '#',
              time:        cell.querySelector('.ago')?.innerText || '',
              contentHtml: cell.querySelector('.reply_content')?.innerHTML || '',
              floor:       cell.querySelector('.no')?.innerText || '#',
            });
          }
        } catch (_) {}
      });
      return comments.sort((a, b) => b.likes - a.likes);
    }

    function buildUI(comments) {
      document.getElementById('hot-overlay')?.remove();
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

          const avatar = document.createElement('img');
          avatar.className = 'user-avatar'; avatar.src = c.avatar;
          header.appendChild(avatar);

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
          content.innerHTML = c.contentHtml;

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
      overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(overlay); });
      const onKey = e => { if (e.key === 'Escape') closeOverlay(overlay); };
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
          btn.id = 'v2ex-hot-btn'; btn.innerText = '高赞';
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
  // 7) 功能E：j/k 键盘导航（MutationObserver 版，零延迟）
  // =========================
  const NavKeys = (() => {
    const SCROLL_OFFSET_RATIO = CONFIG.nav.scrollOffsetRatio;
    let newReplies = [], curIndex = -1, hudTimer = null;

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
      document.querySelectorAll('.reply-nav-active').forEach(e => e.classList.remove('reply-nav-active'));
      if (el) (el.closest('.reply-wrapper') || el).classList.add('reply-nav-active');
    }
    function refreshList() { newReplies = Array.from(document.querySelectorAll('.reply-new')); }
    function navigate(direction) {
      refreshList();
      if (!newReplies.length) return;
      curIndex = direction === 'next'
        ? Math.min(curIndex + 1, newReplies.length - 1)
        : Math.max(curIndex - 1, 0);
      const target = newReplies[curIndex];
      setActive(target); scrollToReply(target); showHud(curIndex, newReplies.length, direction);
    }
    function onKeyDown(e) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.getElementById('hot-overlay')?.classList.contains('active')) return;
      if (e.key === 'j') { e.preventDefault(); navigate('next'); }
      else if (e.key === 'k') { e.preventDefault(); navigate('prev'); }
    }
    function waitAndBoot() {
      // MutationObserver 替代 setInterval 轮询，DOM 变化时立即响应
      const observer = new MutationObserver(() => {
        if (document.querySelectorAll('.reply-new').length > 0) {
          observer.disconnect();
          refreshList();
          document.addEventListener('keydown', onKeyDown);
          log(`NavKeys ready: ${newReplies.length} new replies`);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // 保底：ThreadTree 可能在 NavKeys.boot() 之前已完成渲染
      if (document.querySelectorAll('.reply-new').length > 0) {
        observer.disconnect();
        refreshList();
        document.addEventListener('keydown', onKeyDown);
        log(`NavKeys ready (instant): ${newReplies.length} new replies`);
      }
    }
    function boot() { if (!isTopicPage()) return; waitAndBoot(); }
    return { boot };
  })();

  // =========================
  // 8) 功能F：Imgur 图片代理
  // =========================
  const ImgurProxy = (() => {
    function processImage(img) {
      const src = img.getAttribute('src');
      if (!src || !src.includes('imgur.com') || src.includes('external-content.duckduckgo.com')) return;
      let fullUrl = src.startsWith('//') ? 'https:' + src : src.startsWith('http') ? src : 'https://' + src;
      img.setAttribute('src', `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(fullUrl)}&f=1&nofb=1`);
      img.dataset.proxied = '1';
      const parent = img.parentElement;
      if (parent?.tagName?.toLowerCase() === 'a') {
        const href = parent.getAttribute('href');
        if (href?.includes('imgur.com') && !href.includes('duckduckgo.com')) {
          const fullHref = href.startsWith('//') ? 'https:' + href : href;
          parent.setAttribute('href', `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(fullHref)}&f=1&nofb=1`);
        }
      }
    }
    function scanAll() { document.querySelectorAll('img[src*="imgur.com"]').forEach(processImage); }
    function boot() {
      scanAll();
      new MutationObserver(mutations => {
        if (mutations.some(m => m.addedNodes?.length > 0)) scanAll();
      }).observe(document.body, { childList: true, subtree: true });
    }
    return { boot };
  })();

  // =========================
  // 9) 启动
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
