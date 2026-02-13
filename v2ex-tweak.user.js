// ==UserScript==
// @name         V2EX Suite - 楼层树重排 + Base64 解码 + 自动签到 + 高赞阅览室（协同增强版）
// @namespace    http://tampermonkey.net/
// @version      2.1.0
// @description  多页全量加载后按 HN 风格楼层树重排（增强识别：锚点引用/#楼层/@强弱）；Base64 自动解码（兼容重排/动态）；全站自动签到；高赞回复沉浸阅览室（基于全量回复）
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
  // 配置区（按需开关）
  // =========================
  const CFG = {
    // 1) 楼层树重排（仅帖子页）
    threadTree: {
      enabled: true,
      // 抓取其它分页的并发数（页数很大时非常重要）
      fetchConcurrency: 4,
      // 加载条文本开关
      showLoadingBar: true,
      // “新回复”标记
      markNewReplies: true,

      // ✅ 新增：弱 @ 是否也尝试挂载（误判风险更高）
      // false（推荐更准）：只对“强@（开头@）”挂载；中后部@不挂
      // true（更“连线”）：弱@也按最近发言挂载
      attachWeakAt: false,
    },

    // 2) Base64 自动解码（仅帖子页）
    base64: {
      enabled: true,
      MAX_LEN: 4096,
      URL_ONLY: true, // true=只展示解码后像 URL 的内容
      TARGET_SELECTORS: ['.topic_content', '.reply_content'],
      SKIP_IN_LINK: true,
      // 观察 DOM 变更（兼容楼层重排/懒加载/编辑器插入等）
      observeDom: true,
    },

    // 3) 自动签到（全站）
    daily: {
      enabled: true,
      dailyPage: '/mission/daily',
      delayMinMs: 1500,
      delayMaxMs: 3800,
      storeKey: 'v2ex_daily_check_ymd_v2suite_v1',
      notify: true,
    },

    // 4) 高赞回复阅览室（仅帖子页）
    hot: {
      enabled: true,
    },
  };

  const isTopicPage = /^\/t\/\d+/.test(location.pathname);

  // =========================
  // 通用工具
  // =========================
  const log = (...args) => console.log('[V2EX-Suite]', ...args);

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function waitForSelector(selector, timeoutMs = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(50);
    }
    return null;
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, 'text/html');
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

  // 并发限制 map
  async function mapLimit(items, limit, worker) {
    const ret = [];
    let idx = 0;
    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
      while (idx < items.length) {
        const cur = idx++;
        ret[cur] = await worker(items[cur], cur);
      }
    });
    await Promise.all(runners);
    return ret;
  }

  function notify(title, text) {
    if (!CFG.daily.notify) return;
    try {
      GM_notification({ title, text, timeout: 4000 });
    } catch (_) {}
  }

  // =========================
  // 样式：合并注入（避免重复插入）
  // =========================
  GM_addStyle(`
    :root {
      --indent-width: 16px;
      --line-color: #f0f0f0;
      --line-hover: #c0c0c0;
      --bg-hover: #fafafa;
      --bg-new: #fffdf9;
    }

    /* ===== 楼层树重排样式 ===== */
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

    /* ===== Base64 badge 样式 ===== */
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

    /* ===== 高赞阅览室样式 ===== */
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
  // 1) 自动签到（全站）
  // =========================
  const Daily = (() => {
    function ymdLocal() {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function isLoggedIn() {
      const hasSignOut = !!document.querySelector('a[href="/signout"]');
      const hasSignIn = !!document.querySelector('a[href="/signin"]');
      return hasSignOut || !hasSignIn;
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

      const any = [...doc.querySelectorAll('[onclick]')].find(el => {
        const s = el.getAttribute('onclick') || '';
        return s.includes('/mission/daily/redeem');
      });
      if (any) {
        const s = any.getAttribute('onclick') || '';
        const m = s.match(/'([^']+)'/);
        if (m?.[1]) return m[1];
      }
      return null;
    }

    async function run() {
      if (!CFG.daily.enabled) return;
      if (!isLoggedIn()) return;

      const today = ymdLocal();
      const last = GM_getValue(CFG.daily.storeKey, '');
      if (last === today) return;

      // 先标记今日已尝试，避免多标签页重复
      GM_setValue(CFG.daily.storeKey, today);

      await sleep(randInt(CFG.daily.delayMinMs, CFG.daily.delayMaxMs));

      try {
        const html1 = await fetchText(CFG.daily.dailyPage);
        const doc1 = parseHtml(html1);

        if (alreadyRedeemed(doc1)) {
          notify('V2EX 签到', '今日奖励已领取（或已完成）');
          return;
        }

        const redeemUrl = findRedeemUrl(doc1);
        if (!redeemUrl) {
          notify('V2EX 签到', '未找到领取按钮/链接（可能结构变更）');
          return;
        }

        const html2 = await fetchText(redeemUrl);
        const doc2 = parseHtml(html2);

        if (alreadyRedeemed(doc2) || /奖励/.test(doc2.body?.innerText || '')) {
          notify('V2EX 签到', '领取成功 ✅');
        } else {
          notify('V2EX 签到', '已发起领取，请打开 /mission/daily 确认');
        }
      } catch (err) {
        GM_setValue(CFG.daily.storeKey, ''); // 出错允许当天重试
        notify('V2EX 签到', `失败：${err?.message || err}`);
      }
    }

    return { run };
  })();

  // =========================
  // 2) 楼层树重排（仅帖子页）- 增强识别版
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

      return {
        element: cell,
        id: replyId, // DOM id 的数字部分（与 #r_xxx 匹配）
        author: authorEl.innerText,
        floor: parseInt(floorEl.innerText, 10),
        contentHtml: contentEl.innerHTML,
        textContent: contentEl.innerText,
        avatar: avatarEl ? avatarEl.src : '',
        children: [],
      };
    }

    function extractRepliesFromDoc(doc) {
      const cells = Array.from(doc.querySelectorAll('div.cell[id^="r_"]'));
      return cells.map(parseReplyCell).filter(Boolean);
    }

    // 取“去掉 code/pre 后”的纯文本，降低代码块里 #123 误判
    function getTextNoCode(contentEl) {
      try {
        const clone = contentEl.cloneNode(true);
        clone.querySelectorAll('pre, code').forEach(n => n.remove());
        return clone.innerText || '';
      } catch {
        return contentEl?.innerText || '';
      }
    }

    /**
     * 父级推断（增强版）
     * 优先级：
     * 1) 显式锚点引用 (#r_123 / /t/xxx#r_123)
     * 2) @user + #floor 精准匹配（支持多@多#）
     * 3) 强@（开头@）挂到该用户最近一次发言
     * 4) 只有 #floor
     * 5) 弱@（中后部@）：默认不挂（CFG.threadTree.attachWeakAt=true 时才按最近一次发言挂）
     */
    function inferParent(reply, allReplies, maps) {
      const { byFloor, byDomId } = maps;

      const contentEl = reply.element.querySelector('.reply_content');
      if (!contentEl) return null;

      const html = reply.contentHtml || '';
      const textNoCode = getTextNoCode(contentEl);
      const text = (textNoCode || '').trim();

      // ---- 提取所有 @mentions（优先用 member 链接）----
      const mentionAnchors = Array.from(contentEl.querySelectorAll('a[href^="/member/"]'));
      const mentions = mentionAnchors
        .map(a => (a.getAttribute('href') || '').match(/^\/member\/([A-Za-z0-9_]+)$/)?.[1])
        .filter(Boolean);

      // fallback：极少数情况下 @ 没转成链接
      if (mentions.length === 0) {
        const m = text.match(/@([A-Za-z0-9_]{1,20})/g);
        if (m) mentions.push(...m.map(s => s.slice(1)));
      }

      // ---- 抽取所有 #floor 引用（支持多个）----
      const floorRefs = Array.from(text.matchAll(/#(\d{1,6})/g))
        .map(x => parseInt(x[1], 10))
        .filter(n => Number.isFinite(n));

      // ---- 1) 显式锚点引用：a[href*="#r_..."] 或文本出现 r_123 ----
      // DOM 解析更稳：支持 /t/xxx#r_123 / #r_123
      const anchorA = Array.from(contentEl.querySelectorAll('a[href*="#r_"]'))
        .map(a => (a.getAttribute('href') || '').match(/#(r_\d+)/)?.[1])
        .find(Boolean);

      const anchorText = (() => {
        const m = text.match(/\b(r_\d{3,})\b/);
        return m ? m[1] : null;
      })();

      const anchorId = anchorA || anchorText;
      if (anchorId) {
        const target = byDomId.get(anchorId);
        if (target && target.floor < reply.floor) return target;
      }

      // ---- 2) 精准：@user + #floor（支持多@多#：优先能匹配作者的那一个） ----
      if (mentions.length && floorRefs.length) {
        for (const f of floorRefs) {
          if (f >= reply.floor) continue;
          const t = byFloor.get(f);
          if (!t) continue;
          if (mentions.some(u => u.toLowerCase() === t.author.toLowerCase())) {
            return t;
          }
        }
      }

      // ---- 3) 强@：回复开头就是 @user（点 Reply 自动补 @ 的典型习惯）----
      const strongAt = (() => {
        const t = text.replace(/^[\s>\-–—：:，,。.!?（）()【】\[\]]+/, '');

        // 开头是 @xxx
        const m1 = t.match(/^@([A-Za-z0-9_]{1,20})\b/);
        if (m1?.[1]) return m1[1];

        // 或 HTML 里开头就是 member 链接（某些情况下 innerText 不以 @ 开头）
        const trimmedHtml = (html || '').trim().replace(/^<br\s*\/?>/i, '').trim();
        const m2 = trimmedHtml.match(/^<a[^>]+href="\/member\/([A-Za-z0-9_]+)"/i);
        return m2?.[1] || null;
      })();

      if (strongAt) {
        const targetUser = strongAt.toLowerCase();
        for (let i = allReplies.length - 1; i >= 0; i--) {
          const r = allReplies[i];
          if (r.floor < reply.floor && r.author.toLowerCase() === targetUser) {
            return r;
          }
        }
      }

      // ---- 4) 只有 #floor ----
      if (floorRefs.length) {
        for (const f of floorRefs) {
          if (f < reply.floor) {
            const p = byFloor.get(f);
            if (p) return p;
          }
        }
      }

      // ---- 5) 弱@：中后部@（误判风险高）----
      if (mentions.length) {
        if (!CFG.threadTree.attachWeakAt) return null;

        // 更愿意连线：按最近一次发言挂（更可能误判）
        const targetUser = mentions[0].toLowerCase();
        for (let i = allReplies.length - 1; i >= 0; i--) {
          const r = allReplies[i];
          if (r.floor < reply.floor && r.author.toLowerCase() === targetUser) return r;
        }
      }

      return null;
    }

    function renderTree(flatReplies, container) {
      const byFloor = new Map();
      const byDomId = new Map(); // key like 'r_123456'
      const roots = [];

      flatReplies.forEach(r => {
        byFloor.set(r.floor, r);
        byDomId.set(`r_${r.id}`, r);
        r.children = [];
      });

      flatReplies.forEach(r => {
        const parent = inferParent(r, flatReplies, { byFloor, byDomId });
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
      if (!CFG.threadTree.markNewReplies) return;

      const STORAGE_KEY = `v2_last_read_${topicId}`;
      const storedValue = localStorage.getItem(STORAGE_KEY);

      let maxFloor = 0;
      for (const r of replies) maxFloor = Math.max(maxFloor, r.floor);

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

    function getTotalPages() {
      let totalPages = 1;
      const pageInput = document.querySelector('.page_input');
      if (pageInput && pageInput.max) {
        totalPages = parseInt(pageInput.max, 10) || 1;
      } else {
        const pageLinks = document.querySelectorAll('a.page_normal');
        if (pageLinks.length > 0) {
          totalPages = parseInt(pageLinks[pageLinks.length - 1].innerText, 10) || 1;
        }
      }
      return Math.max(1, totalPages);
    }

    function cleanupPagination() {
      document.querySelectorAll('.page_input, .page_current, .page_normal').forEach(el => el.closest('div')?.remove());
      document.querySelectorAll('a[name="last_page"]').forEach(e => e.remove());
      const bottom = document.getElementById('bottom-pagination');
      if (bottom) bottom.remove();
    }

    async function init() {
      if (!CFG.threadTree.enabled) return { replyBox: null, allReplies: [] };
      const topicId = location.pathname.match(/\/t\/(\d+)/)?.[1];
      if (!topicId) return { replyBox: null, allReplies: [] };

      const replyBox =
        Array.from(document.querySelectorAll('.box')).find(b => b.querySelector('div[id^="r_"]')) || null;
      if (!replyBox) return { replyBox: null, allReplies: [] };

      let loadingBar = null;
      if (CFG.threadTree.showLoadingBar) {
        loadingBar = document.createElement('div');
        loadingBar.id = 'v2ex-loading-bar';
        loadingBar.innerText = '加载中...';
        replyBox.parentNode.insertBefore(loadingBar, replyBox);
      }

      const totalPages = getTotalPages();
      const currentP = new URLSearchParams(location.search).get('p');
      const currentPage = currentP ? (parseInt(currentP, 10) || 1) : 1;

      // 先取本页
      let allReplies = extractRepliesFromDoc(document);

      // 再抓其它页（并发限制）
      if (totalPages > 1) {
        const pages = [];
        for (let p = 1; p <= totalPages; p++) {
          if (p === currentPage) continue;
          pages.push(p);
        }

        let done = 0;
        const results = await mapLimit(pages, CFG.threadTree.fetchConcurrency, async (p) => {
          try {
            if (loadingBar) loadingBar.innerText = `加载中...（${done}/${pages.length}）`;
            const html = await fetchText(`${location.pathname}?p=${p}`);
            const doc = parseHtml(html);
            return extractRepliesFromDoc(doc);
          } finally {
            done++;
            if (loadingBar) loadingBar.innerText = `加载中...（${done}/${pages.length}）`;
          }
        });

        for (const list of results) allReplies = allReplies.concat(list);
      }

      // 排序、清理分页、渲染树
      allReplies.sort((a, b) => a.floor - b.floor);
      cleanupPagination();
      renderTree(allReplies, replyBox);
      handleReadStatus(topicId, allReplies);

      if (loadingBar) loadingBar.remove();

      return { replyBox, allReplies };
    }

    return { init };
  })();

  // =========================
  // 3) Base64 自动解码（仅帖子页）
  // =========================
  const Base64Decoder = (() => {
    const B64_RE = /(^|[^A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{16,}={0,2})(?=[^A-Za-z0-9+/_-]|$)/g;

    function normalizeBase64(s) {
      let x = s.replace(/-/g, '+').replace(/_/g, '/').trim();
      const pad = x.length % 4;
      if (pad) x += '='.repeat(4 - pad);
      return x;
    }

    function tryDecodeBase64(raw) {
      if (!raw || raw.length < 16 || raw.length > CFG.base64.MAX_LEN) return null;

      const norm = normalizeBase64(raw);
      let bin;
      try { bin = atob(norm); } catch { return null; }

      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

      const bad = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
      if (bad > 0) return null;

      if (CFG.base64.URL_ONLY) {
        if (text.includes('://')) return text;
        return null;
      }

      if (!text.trim()) return null;
      return text;
    }

    function makeBadge(raw, decoded) {
      const wrap = document.createElement('span');
      wrap.className = 'v2-b64-badge';
      wrap.title = `base64: ${raw}`;

      const label = document.createElement('span');
      label.className = 'v2-b64-text';
      label.textContent = decoded;
      wrap.appendChild(label);

      const btnCopy = document.createElement('button');
      btnCopy.className = 'v2-b64-btn';
      btnCopy.textContent = '复制';
      btnCopy.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        GM_setClipboard(decoded);
        btnCopy.textContent = '已复制';
        setTimeout(() => (btnCopy.textContent = '复制'), 900);
      });
      wrap.appendChild(btnCopy);

      if (decoded.includes('://')) {
        const a = document.createElement('a');
        a.className = 'v2-b64-link';
        a.textContent = '打开';
        a.href = decoded;
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        wrap.appendChild(a);
      }

      return wrap;
    }

    function shouldSkipTextNode(node) {
      if (!node || !node.parentElement) return true;
      const p = node.parentElement;
      if (!node.nodeValue || node.nodeValue.length < 16) return true;
      if (CFG.base64.SKIP_IN_LINK && p.closest('a')) return true;
      if (p.closest('.v2-b64-badge')) return true;
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
        const raw = m[2];
        const decoded = tryDecodeBase64(raw);
        if (!decoded) continue;

        changed = true;
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        if (prefix) frag.appendChild(document.createTextNode(prefix));
        frag.appendChild(makeBadge(raw, decoded));

        last = m.index + prefix.length + raw.length;
      }

      if (!changed) return;
      frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
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

      el.dataset.v2b64scanned = '1';
    }

    function scanAll() {
      for (const sel of CFG.base64.TARGET_SELECTORS) {
        document.querySelectorAll(sel).forEach(scanElement);
      }
    }

    function startObserver() {
      if (!CFG.base64.observeDom) return;

      let scheduled = false;
      const scheduleScan = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          scanAll();
        }, 50);
      };

      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'childList' && (m.addedNodes?.length || m.removedNodes?.length)) {
            scheduleScan();
            break;
          }
          if (m.type === 'characterData') {
            scheduleScan();
            break;
          }
        }
      });

      const root = document.querySelector('#Main') || document.body;
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    function init() {
      if (!CFG.base64.enabled) return;
      scanAll();
      startObserver();
    }

    return { init, scanAll };
  })();

  // =========================
  // 4) 高赞回复阅览室（仅帖子页）
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
            const m = text.match(/(?:♥|❤️)\s*(\d+)/);
            if (m) { likes = parseInt(m[1], 10) || 0; break; }

            const heartImg = span.querySelector('img[alt="❤️"]');
            if (heartImg && text.trim().length > 0) {
              likes = parseInt(text.trim(), 10) || 0;
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
        } catch (e) {}
      });

      return comments.sort((a, b) => b.likes - a.likes);
    }

    function buildUI(comments) {
      const old = document.getElementById('hot-overlay');
      if (old) old.remove();

      const overlay = document.createElement('div');
      overlay.id = 'hot-overlay';

      let cardsHtml = '';
      comments.forEach((c, index) => {
        let rankClass = 'rank-normal';
        if (index === 0) rankClass = 'rank-1';
        else if (index === 1) rankClass = 'rank-2';
        else if (index === 2) rankClass = 'rank-3';

        cardsHtml += `
          <div class="hot-card ${rankClass}">
            <div class="card-header-row">
              <img src="${c.avatar}" class="user-avatar">
              <a href="${c.userUrl}" target="_blank" class="user-name">${c.username}</a>
              <div class="floor-tag" data-jump="${c.id}" title="跳转">${c.floor}</div>
              <span class="time-tag">${c.time}</span>
              <div class="likes-pill">♥ ${c.likes}</div>
            </div>
            <div class="card-content">${c.contentHtml}</div>
          </div>
        `;
      });

      if (comments.length === 0) {
        cardsHtml = `<div style="text-align:center;padding:40px;color:#ccc;font-size:13px;">暂无高赞回复</div>`;
      }

      overlay.innerHTML = `<div class="hot-container">${cardsHtml}</div>`;
      document.body.appendChild(overlay);

      const close = () => {
        overlay.classList.remove('active');
        setTimeout(() => {
          if (!overlay.classList.contains('active')) overlay.remove();
        }, 200);
      };

      // 点击背景关闭
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });

      // 点击楼层跳转
      overlay.addEventListener('click', (e) => {
        const t = e.target;
        if (!(t instanceof HTMLElement)) return;
        const id = t.getAttribute('data-jump');
        if (!id) return;

        overlay.classList.remove('active');
        setTimeout(() => {
          const el = document.getElementById(id);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 250);
      });

      // ESC 关闭（用 addEventListener，不覆盖别人）
      const onKey = (e) => {
        if (e.key === 'Escape') {
          close();
          window.removeEventListener('keydown', onKey, true);
        }
      };
      window.addEventListener('keydown', onKey, true);

      return overlay;
    }

    function initButton() {
      if (!CFG.hot.enabled) return;

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

    function init() {
      // 让页面先稳定一点（尤其是楼层树重排后）
      setTimeout(initButton, 500);
    }

    return { init };
  })();

  // =========================
  // 主流程：按“协同顺序”执行
  // =========================
  async function main() {
    // A) 全站自动签到（不阻塞其它功能）
    Daily.run();

    if (!isTopicPage) return;

    // B) 等待主体区域出现
    const mainEl = await waitForSelector('#Main');
    if (!mainEl) return;

    // C) 楼层树重排（可能异步抓多页）
    if (CFG.threadTree.enabled) {
      try {
        await ThreadTree.init();
      } catch (e) {
        log('ThreadTree error:', e);
      }
    }

    // D) Base64 解码（重排完成后扫一次，并挂 observer 兼容后续 DOM 变更）
    if (CFG.base64.enabled) {
      try {
        Base64Decoder.init();
      } catch (e) {
        log('Base64 error:', e);
      }
    }

    // E) 高赞阅览室（基于“当前 DOM”，因此放在重排之后）
    if (CFG.hot.enabled) {
      try {
        HotRoom.init();
      } catch (e) {
        log('HotRoom error:', e);
      }
    }
  }

  main();
})();
