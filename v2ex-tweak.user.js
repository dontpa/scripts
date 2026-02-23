// ==UserScript==
// @name         V2EX 全功能增强（楼层树/多页 + Base64解码 + 自动签到 + 高赞阅览室）
// @namespace    https://tampermonkey.net/
// @version      2.0.3
// @description  多页加载并以 Hacker News 风格重排楼层；Base64 自动解码（含短文本，防误报机制）；每日自动签到；高赞回复阅览室。
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
      --line-color: #f0f0f0;
      --line-hover: #c0c0c0;
      --bg-hover: #fafafa;
      --bg-new: #fffdf9;
    }

    .box { padding-bottom: 0 !important; }

    .reply-children {
      margin-left: var(--indent-width);
      border-left: 2px solid var(--line-color);
      transition: border-color 0.2s;
    }
    .reply-children:hover { border-left-color: var(--line-hover); }

    .reply-wrapper .cell {
      padding: 6px 8px !important;
      border-bottom: 1px solid #fafafa !important;
      background: transparent;
    }
    .reply-wrapper > .cell:hover { background-color: var(--bg-hover); }

    .reply-wrapper .avatar {
      width: 36px !important;
      height: 36px !important;
      border-radius: 4px;
    }
    .reply_content {
      font-size: 14px;
      line-height: 1.5;
      margin-top: 2px;
    }
    .ago, .no, .fade { font-size: 11px !important; }

    .reply-new > .cell { background-color: var(--bg-new) !important; }

    .new-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      background-color: #ff4d4f;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: middle;
      position: relative;
      top: -1px;
      box-shadow: 0 0 3px rgba(255, 77, 79, 0.4);
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

    /* ===== Base64 Badge（极简）===== */
    .v2-b64-badge{
      display:inline-flex; gap:6px; align-items:center;
      margin-left:6px; padding:2px 6px; border-radius:6px;
      font-size:12px; line-height:1.6;
      background:rgba(0,0,0,.06);
      border:1px solid rgba(0,0,0,.08);
      vertical-align:middle;
      user-select:text;
      max-width:520px;
    }
    .v2-b64-text{
      overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    }
    .v2-b64-btn{
      cursor:pointer; font-size:12px; padding:1px 6px;
      border:1px solid rgba(0,0,0,.12); border-radius:4px;
      background:transparent;
    }
    .v2-b64-link{
      font-size:12px; text-decoration:none; padding:1px 6px;
      border:1px solid rgba(0,0,0,.12); border-radius:4px;
      color:inherit;
    }

    /* ===== 高赞阅览室（宽屏沉浸版）===== */
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
    .user-avatar { width: 18px; height: 18px; border-radius: 3px; margin-right: 8px; }
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
  // 3) 功能B：Base64 自动解码（大幅降低长度限制）
  // =========================
  const B64 = (() => {
    const CFG = {
      MAX_LEN: 4096,
      URL_ONLY: false,
      TARGET_SELECTORS: ['.topic_content', '.reply_content'],
      SKIP_IN_LINK_TEXT_REPLACE: true,
    };

    const SEP_RE = /[\s\u200b\u200c\u200d\uFEFF]/g;
    // 将 {15,} 降为 {7,} -> 即最小基础字符只需 8 个 (约 6 个字节)
    const B64_RE = /(^|[^A-Za-z0-9+/_-])([A-Za-z0-9+/_-](?:[\s\u200b\u200c\u200d\uFEFF]*[A-Za-z0-9+/_-]){7,}(?:[\s\u200b\u200c\u200d\uFEFF]*={0,2}))(?=[^A-Za-z0-9+/_-]|$)/g;

    function normalizeBase64(s) {
      let x = s.replace(/-/g, '+').replace(/_/g, '/').trim();
      const pad = x.length % 4;
      if (pad) x += '='.repeat(4 - pad);
      return x;
    }

    function safeDecodeURIComponent(s) {
      try { return decodeURIComponent(s); } catch (_) {}
      try { return decodeURI(s); } catch (_) {}
      return null;
    }

    function extractFirstUrl(s) {
      if (!s) return null;
      const m = s.match(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>\x00-\x08\x0B\x0C\x0E-\x1F]+/);
      return m ? m[0] : null;
    }

    function tryDecodeBase64(raw) {
      if (!raw) return null;
      const cleaned = raw.replace(SEP_RE, '');
      // 最小长度降低到 8 (匹配正则设定)
      if (cleaned.length < 8 || cleaned.length > CFG.MAX_LEN) return null;

      const norm = normalizeBase64(cleaned);

      let bin;
      try { bin = atob(norm); } catch { return null; }

      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      // 解码 UTF-8
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      // --- 防误报核心逻辑 ---
      const hasReplacement = text.includes('\ufffd');
      const cleanText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      const url1 = extractFirstUrl(cleanText);

      if (url1) return { display: url1, url: url1 };
      if (hasReplacement) return null;
      if (text.length !== cleanText.length) return null;

      if (!CFG.URL_ONLY) {
        const t = cleanText.trim();
        if (!t) return null;

        if (/%[0-9A-Fa-f]{2}/.test(t)) {
          const u = safeDecodeURIComponent(t);
          if (u) {
            const url2 = extractFirstUrl(u);
            if (url2) return { display: url2, url: url2 };
            return { display: u, url: null };
          }
        }
        
        if (t.includes('://')) {
          const url3 = extractFirstUrl(t);
          if (url3) return { display: url3, url: url3 };
        }

        return { display: t, url: null };
      }

      return null;
    }

    function makeBadge(raw, decodedObj) {
      const { display, url } = decodedObj;

      const wrap = document.createElement('span');
      wrap.className = 'v2-b64-badge';
      wrap.title = `base64: ${raw.replace(SEP_RE, '')}`;

      const label = document.createElement('span');
      label.className = 'v2-b64-text';
      label.textContent = display;
      wrap.appendChild(label);

      const btnCopy = document.createElement('button');
      btnCopy.className = 'v2-b64-btn';
      btnCopy.textContent = '复制';
      btnCopy.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        GM_setClipboard(display);
        btnCopy.textContent = '已复制';
        setTimeout(() => (btnCopy.textContent = '复制'), 900);
      });
      wrap.appendChild(btnCopy);

      if (url) {
        const a = document.createElement('a');
        a.className = 'v2-b64-link';
        a.textContent = '打开';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        wrap.appendChild(a);
      }

      return wrap;
    }

    function shouldSkipTextNode(node) {
      if (!node || !node.parentElement) return true;
      // 降低排除门槛
      if (!node.nodeValue || node.nodeValue.length < 8) return true;
      const p = node.parentElement;
      if (p.closest('.v2-b64-badge')) return true;
      if (CFG.SKIP_IN_LINK_TEXT_REPLACE && p.closest('a')) return true;
      return false;
    }

    function processTextNode(node) {
      const text = node.nodeValue;
      B64_RE.lastIndex = 0;

      let m, last = 0;
      let changed = false;
      const frag = document.createDocumentFragment();

      while ((m = B64_RE.exec(text)) !== null) {
        const prefix = m[1] || '';
        const rawWithSep = m[2];

        const decodedObj = tryDecodeBase64(rawWithSep);
        if (!decodedObj) continue;

        changed = true;
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (prefix) frag.appendChild(document.createTextNode(prefix));
        frag.appendChild(makeBadge(rawWithSep, decodedObj));

        last = m.index + prefix.length + rawWithSep.length;
      }

      if (!changed) return;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }

    function processLinkText(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.matches('a')) return;
      if (el.dataset.v2b64linkscanned === '1') return;

      const t = el.textContent || '';
      const m = t.match(/[A-Za-z0-9+/_-](?:[\s\u200b\u200c\u200d\uFEFF]*[A-Za-z0-9+/_-]){7,}(?:[\s\u200b\u200c\u200d\uFEFF]*={0,2})/);
      if (m) {
        const decodedObj = tryDecodeBase64(m[0]);
        if (decodedObj) {
          const badge = makeBadge(m[0], decodedObj);
          el.insertAdjacentElement('afterend', badge);
        }
      }

      el.dataset.v2b64linkscanned = '1';
    }

    function scanElement(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.dataset.v2b64scanned === '1') return;

      const walker = document.createTreeWalker(
        el,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => (shouldSkipTextNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
        }
      );

      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach(processTextNode);

      if (CFG.SKIP_IN_LINK_TEXT_REPLACE) {
        el.querySelectorAll('a').forEach(processLinkText);
      }

      el.dataset.v2b64scanned = '1';
    }

    function scanAll() {
      for (const sel of CFG.TARGET_SELECTORS) {
        document.querySelectorAll(sel).forEach(scanElement);
      }
    }

    let scheduled = false;
    const scheduleScan = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        scanAll();
      }, 60);
    };

    function boot() {
      if (!isTopicPage()) return;
      scanAll();
      const root = document.querySelector('#Main') || document.body;
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList' && (m.addedNodes?.length || m.removedNodes?.length)) { scheduleScan(); break; }
          if (m.type === 'characterData') { scheduleScan(); break; }
        }
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    return { boot };
  })();

  // =========================
  // 4) 功能C：楼层树 + 多页加载
  // =========================
  const ThreadTree = (() => {
    function parseReplyCell(cell) {
      if (!cell || !cell.id || !cell.id.startsWith('r_')) return null;

      const replyId = cell.id.replace('r_', '');
      const contentEl = cell.querySelector('.reply_content');
      const authorEl = cell.querySelector('strong a');
      const floorEl = cell.querySelector('.no');
      const avatarEl = cell.querySelector('img.avatar');

      if (!contentEl || !authorEl || !floorEl) return null;

      const mentionUsers = Array.from(contentEl.querySelectorAll('a[href^="/member/"]'))
        .map(a => (a.getAttribute('href') || '').split('/').pop())
        .filter(Boolean);

      const plainMentions = (contentEl.innerText.match(/@([A-Za-z0-9_]+)/g) || []).map(s => s.slice(1));
      const allMentions = Array.from(new Set([...mentionUsers, ...plainMentions]));

      return {
        element: cell,
        id: replyId,
        author: authorEl.innerText,
        floor: parseInt(floorEl.innerText, 10),
        contentHtml: contentEl.innerHTML,
        textContent: contentEl.innerText,
        avatar: avatarEl ? avatarEl.src : '',
        mentions: allMentions,
        children: [],
      };
    }

    function extractRepliesFromDoc(doc) {
      const cells = Array.from(doc.querySelectorAll('div.cell[id^="r_"]'));
      return cells.map(parseReplyCell).filter(Boolean);
    }

    function inferParent(reply, allReplies) {
      const floorMatch = reply.textContent.match(/#(\d+)/);
      const targetFloor = floorMatch ? parseInt(floorMatch[1], 10) : null;
      const targetUser = reply.mentions?.[0] || null;

      if (targetUser && targetFloor) {
        const targetReply = allReplies.find(r => r.floor === targetFloor);
        if (targetReply && targetReply.author.toLowerCase() === targetUser.toLowerCase()) {
          return targetReply;
        }
      }

      if (targetUser) {
        for (let i = allReplies.length - 1; i >= 0; i--) {
          const r = allReplies[i];
          if (r.floor < reply.floor && r.author.toLowerCase() === targetUser.toLowerCase()) return r;
        }
      }

      if (targetFloor && targetFloor < reply.floor) {
        const parent = allReplies.find(r => r.floor === targetFloor);
        if (parent) return parent;
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
          const childrenContainer = document.createElement('div');
          childrenContainer.className = 'reply-children';
          reply.children.forEach(child => appendNode(child, childrenContainer));
          wrapper.appendChild(childrenContainer);
        }
        parentContainer.appendChild(wrapper);
      }

      roots.forEach(r => appendNode(r, fragment));
      container.innerHTML = '';
      container.appendChild(fragment);
    }

    function handleReadStatus(topicId, replies) {
      const STORAGE_KEY = `v2_last_read_${topicId}`;
      const storedValue = localStorage.getItem(STORAGE_KEY);
      let maxFloor = 0;
      for (const r of replies) if (r.floor > maxFloor) maxFloor = r.floor;

      if (storedValue === null) {
        localStorage.setItem(STORAGE_KEY, String(maxFloor));
        return;
      }

      const lastReadFloor = parseInt(storedValue, 10) || 0;

      for (const r of replies) {
        if (r.floor > lastReadFloor) {
          r.element.classList.add('reply-new');
          const authorContainer = r.element.querySelector('strong');
          if (authorContainer && !authorContainer.querySelector('.new-dot')) {
            const dot = document.createElement('span');
            dot.className = 'new-dot';
            dot.title = 'New reply';
            authorContainer.prepend(dot);
          }
        }
      }
      localStorage.setItem(STORAGE_KEY, String(maxFloor));
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

      allReplies.sort((a, b) => a.floor - b.floor);
      document.querySelectorAll('.page_input, .page_current, .page_normal')
        .forEach(el => el.closest('div')?.remove());

      renderTree(allReplies, replyBox);
      handleReadStatus(topicId, allReplies);

      loadingBar.remove();
      document.querySelectorAll('a[name="last_page"]').forEach(e => e.remove());
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
  // 6) 启动
  // =========================
  Daily.boot();

  if (isTopicPage()) {
    ThreadTree.boot();
    B64.boot();
    HotRoom.boot();
  }
})();
