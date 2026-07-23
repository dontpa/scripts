// ==UserScript==
// @name         V2EX Tweaks
// @namespace    https://tampermonkey.net/
// @version      2.4.0
// @description  V2EX 日常增强：回复嵌套树 + 合并分页；未读新回复标记 + j/k 跳转；高赞阅览室（图片 Lightbox）；Base64 解码（熵过滤）；折叠状态持久化；悬停引用预览；多页加载失败重试；每日签到；Imgur 代理。
// @author       you
// @match        https://v2ex.com/*
// @match        https://www.v2ex.com/*
// @match        https://edge.v2ex.com/*
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
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
      storeKey: 'v2ex_daily_check_ymd_v3',
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

  function ymdUtc(time = Date.now()) {
    return new Date(time).toISOString().slice(0, 10);
  }

  function isTopicPage() {
    return /^\/t\/\d+(?:\/|$)/.test(location.pathname);
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
  `);

  // =========================
  // 3) 功能A：每日自动签到
  // =========================
  const Daily = (() => {
    const CLAIMED_RE = /每日登录奖励已领取|今天的登录奖励已经领取过了(?:哦)?|今天已经领取|已成功领取每日登录奖励|成功领取每日登录奖励|奖励已发放/i;
    const REJECTED_RE = /浏览器有一些奇奇怪怪的设置|请用一个干净安装的浏览器重试/i;
    const MAX_TIMER_MS = 0x7fffffff;
    let inFlight = null;
    let nextDayTimer = 0;

    function requestText(url) {
      const target = new URL(url, location.origin);
      if (target.origin !== location.origin) return Promise.reject(new Error('拒绝跨站签到请求'));
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          url: target.href,
          responseType: 'text',
          timeout: CONFIG.daily.requestTimeoutMs,
          headers: { Accept: 'text/html,application/xhtml+xml' },
          onload: response => {
            if (response.status < 200 || response.status >= 400) {
              reject(new Error(`HTTP ${response.status} for ${target.pathname}`));
              return;
            }
            resolve({
              text: typeof response.responseText === 'string'
                ? response.responseText
                : (typeof response.response === 'string' ? response.response : ''),
              finalUrl: response.finalUrl || target.href,
            });
          },
          ontimeout: () => reject(new Error(`请求超时：${target.pathname}`)),
          onerror: () => reject(new Error(`请求失败：${target.pathname}`)),
          onabort: () => reject(new Error(`请求已取消：${target.pathname}`)),
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
      return !!doc.querySelector('li.fa.fa-ok-sign, .fa-ok-sign') || CLAIMED_RE.test(pageText(doc));
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

    async function loadPage(url) {
      const response = await requestText(url);
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
        const result = await loadPage(page);
        if (isSignedOut(result.doc, result.finalUrl)) return { status: 'signed-out', result };
        if (REJECTED_RE.test(pageText(result.doc))) return { status: 'rejected', result };
        if (alreadyRedeemed(result.doc)) return { status: 'claimed', result };
        lastStatus = findRedeemUrl(result.doc) ? 'claimable' : 'unknown';
      }
      return { status: lastStatus };
    }

    async function execute() {
      const {
        notify: doNotify, page, delayMinMs, delayMaxMs, storeKey,
        verifyRetries, verifyIntervalMs,
      } = CONFIG.daily;
      const today = ymdUtc();
      if (GM_getValue(storeKey, '') === today) return;
      if (isSignedOut(document, location.href)) {
        log('签到：账号未登录，已跳过');
        return;
      }
      const lockKey = `${storeKey}_lock`;
      const lock = GM_getValue(lockKey, null);
      if (lock?.date === today && Date.now() - lock.startedAt < 5 * 60 * 1000) return;

      const token = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      GM_setValue(lockKey, { date: today, startedAt: Date.now(), token });
      const dailyNotify = text => { if (doNotify) notify('V2EX 签到', text); };

      try {
        await sleep(randInt(delayMinMs, delayMaxMs));
        const daily = await loadPage(page);
        if (isSignedOut(daily.doc, daily.finalUrl)) {
          log('签到：账号未登录，已跳过');
          return;
        }
        if (REJECTED_RE.test(pageText(daily.doc))) {
          throw new Error('V2EX 拒绝了当前浏览器环境');
        }
        if (alreadyRedeemed(daily.doc)) {
          GM_setValue(storeKey, today);
          log('签到：今日奖励已领取');
          dailyNotify('今日奖励已领取');
          return;
        }

        const redeemUrl = findRedeemUrl(daily.doc);
        if (!redeemUrl) {
          throw new Error('未找到领取按钮（页面结构可能已变更）');
        }

        const target = validateRedeemUrl(redeemUrl);
        const redeem = await loadPage(target.href);
        if (isSignedOut(redeem.doc, redeem.finalUrl)) throw new Error('登录状态已失效');
        if (REJECTED_RE.test(pageText(redeem.doc))) throw new Error('V2EX 拒绝了当前浏览器环境');

        let confirmed = alreadyRedeemed(redeem.doc);
        if (!confirmed) {
          const verification = await verifyClaimed(page, verifyRetries, verifyIntervalMs);
          if (verification.status === 'signed-out') throw new Error('登录状态已失效');
          if (verification.status === 'rejected') throw new Error('V2EX 拒绝了当前浏览器环境');
          confirmed = verification.status === 'claimed';
        }

        if (confirmed) {
          GM_setValue(storeKey, today);
          log('签到：领取成功');
          dailyNotify('领取成功 ✅');
        } else {
          throw new Error('领取请求已发送，但服务端未确认成功');
        }
      } finally {
        if (GM_getValue(lockKey, null)?.token === token) GM_setValue(lockKey, null);
      }
    }

    function run() {
      if (inFlight) return inFlight;
      inFlight = execute().catch(err => {
        log('签到失败：', err);
        if (CONFIG.daily.notify) notify('V2EX 签到', `失败：${err?.message || err}`);
      }).finally(() => { inFlight = null; });
      return inFlight;
    }

    function scheduleNextUtcDay() {
      if (nextDayTimer) clearTimeout(nextDayTimer);
      const now = Date.now();
      const current = new Date(now);
      const nextUtcDay = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1);
      const delay = Math.min(nextUtcDay - now + randInt(30000, 120000), MAX_TIMER_MS);
      nextDayTimer = setTimeout(() => {
        run().finally(scheduleNextUtcDay);
      }, delay);
    }

    function boot() {
      const start = () => setTimeout(run, 800);
      if (document.readyState === 'complete') start();
      else window.addEventListener('load', start, { once: true });

      // 页面跨 UTC 日期保持打开时也会重试；后台标签页恢复可见时再补一次。
      scheduleNextUtcDay();
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && GM_getValue(CONFIG.daily.storeKey, '') !== ymdUtc()) run();
      });
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
        const strongEl = r.element.querySelector('strong');
        if (strongEl && !r.element.querySelector('.new-badge')) {
          const badge = document.createElement('span');
          badge.className = 'new-badge'; badge.textContent = 'NEW'; badge.title = '未读新回复';
          strongEl.insertAdjacentElement('afterend', badge);
        }
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

          if (changed) {
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
      const pageResults = await fetchPages(pages, (completed, total) => {
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
    return { boot };
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
