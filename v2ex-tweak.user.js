// ==UserScript==
// @name         V2EX 全功能增强（楼层树/多页 + Base64解码 + 自动签到 + 高赞阅览室 + Imgur代理）
// @namespace    https://tampermonkey.net/
// @version      2.0.6
// @description  多页加载并以 Hacker News 风格重排楼层；Base64 自动解码；每日自动签到；高赞回复阅览室；自动将 Imgur 图片替换为 DuckDuckGo 代理加载。
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

    /**
     * 对字符串进行自定义转义处理，使非 ASCII 字符安全用于 URL 解码。
     */
    function customEscape(str) {
      return str.replace(
        /[^a-zA-Z0-9_.!~*'()-]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
      );
    }

    /**
     * 检查字符串是否可能是 base64 编码并尝试解码。
     * 返回解码后的字符串，或 null（如果无法解码）。
     */
    function tryDecode(text) {
      // 检查长度是否为 4 的倍数
      if (text.length % 4 !== 0) return null;
      // 字符长度太小排除掉
      if (text.length <= CFG.MIN_LEN) return null;
      // 排除已知高频非 base64 字符串
      if (CFG.EXCLUDE_LIST.includes(text)) return null;

      // 检查填充字符 "=" 的位置是否正确（只能在末尾 1 或 2 位）
      if (text.includes('=')) {
        const paddingIndex = text.indexOf('=');
        if (paddingIndex !== text.length - 1 && paddingIndex !== text.length - 2) {
          return null;
        }
      }

      try {
        const decodedStr = decodeURIComponent(customEscape(window.atob(text)));
        // 解码后必须包含有意义的内容（至少有字母、数字或中文）
        if (!/[A-Za-z0-9一-鿿]/.test(decodedStr)) return null;
        return decodedStr;
      } catch (_) {
        return null;
      }
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

      // 如果解码结果是 URL，添加打开链接按钮
      if (/^https?:\/\//i.test(decoded)) {
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

    function processContent(contentEl) {
      if (!contentEl || contentEl.dataset.v2b64scanned === '1') return;

      // 获取需要排除的内容（a 和 img 标签）
      const excludeTextList = [
        ...contentEl.getElementsByTagName('a'),
        ...contentEl.getElementsByTagName('img'),
      ].map((ele) => ele.outerHTML);

      // 遍历所有文本节点
      const walker = document.createTreeWalker(
        contentEl,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: (node) => {
            if (!node.nodeValue || node.nodeValue.length <= CFG.MIN_LEN) {
              return NodeFilter.FILTER_REJECT;
            }
            const p = node.parentElement;
            if (p.closest('.v2-b64-badge')) return NodeFilter.FILTER_REJECT;
            if (p.closest('a, img')) return NodeFilter.FILTER_REJECT;
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

          // 检查是否在排除列表的内容中
          if (excludeTextList.some((excludeText) => excludeText.includes(candidate))) {
            continue;
          }

          const decoded = tryDecode(candidate);
          if (!decoded) continue;

          changed = true;
          frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          frag.appendChild(makeBadge(candidate, decoded));
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
      for (const sel of CFG.TARGET_SELECTORS) {
        document.querySelectorAll(sel).forEach(processContent);
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
          if (m.type === 'childList' && (m.addedNodes?.length || m.removedNodes?.length)) {
            scheduleScan();
            break;
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
    }

    return { boot };
  })();
  // =========================
  // 4) 功能C：楼层树 + 多页加载
  // =========================
  const ThreadTree = (() => {
    // 采用 V2EX_Polish 的楼层识别逻辑
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

      // 提取引用的用户名（@username）
      const memberNameMatches = Array.from(content.matchAll(/@([a-zA-Z0-9]+)/g));
      const refMemberNames = memberNameMatches.length > 0
        ? memberNameMatches.map(([, name]) => name)
        : undefined;

      // 提取引用的楼层号（#123）
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

    // 采用 V2EX_Polish 的嵌套评论查找逻辑
    function inferParent(reply, allReplies) {
      const { refMemberNames, refFloors, index, floorNum } = reply;

      if (!refMemberNames || refMemberNames.length === 0) return null;

      // 从当前评论往前找，找到第一个引用的用户名的评论
      for (let j = index - 1; j >= 0; j--) {
        const r = allReplies[j];
        if (r.memberName.toLowerCase() === refMemberNames[0].toLowerCase()) {
          let parentIdx = j;

          // 如果有楼层号，校验楼层号是否匹配
          const firstRefFloor = refFloors?.[0];
          if (firstRefFloor && parseInt(firstRefFloor, 10) !== r.floorNum) {
            // 找到了指定回复的用户后，发现跟指定楼层对不上，继续寻找
            const targetIdx = allReplies.slice(0, j).findIndex(
              (data) => data.floorNum === parseInt(firstRefFloor, 10) &&
                        data.memberName.toLowerCase() === refMemberNames[0].toLowerCase()
            );
            if (targetIdx >= 0) {
              parentIdx = targetIdx;
            }
          }

          // 确保父楼层在当前楼层之前
          if (allReplies[parentIdx].floorNum < floorNum) {
            return allReplies[parentIdx];
          }
          return null;
        }
      }

      // 如果只引用了楼层号而没有用户名
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
      for (const r of replies) if (r.floorNum > maxFloor) maxFloor = r.floorNum;

      if (storedValue === null) {
        localStorage.setItem(STORAGE_KEY, String(maxFloor));
        return;
      }

      const lastReadFloor = parseInt(storedValue, 10) || 0;

      for (const r of replies) {
        if (r.floorNum > lastReadFloor) {
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

      allReplies.sort((a, b) => a.floorNum - b.floorNum);
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
  // 6) 功能E：Imgur 图片代理 (DuckDuckGo Proxy)
  // =========================
  const ImgurProxy = (() => {
    function processImage(img) {
      const src = img.getAttribute('src');
      if (!src) return;

      // 检查是否包含 imgur.com 且还没被代理过
      if (src.includes('imgur.com') && !src.includes('external-content.duckduckgo.com')) {
        // 补全协议 (有些图片可能以 // 开头)
        let fullUrl = src;
        if (src.startsWith('//')) {
          fullUrl = 'https:' + src;
        } else if (!src.startsWith('http')) {
          fullUrl = 'https://' + src;
        }

        // 替换 src
        const proxyUrl = `https://external-content.duckduckgo.com/iu/?u=${encodeURIComponent(fullUrl)}&f=1&nofb=1`;
        img.setAttribute('src', proxyUrl);
        img.dataset.proxied = '1';

        // 顺带替换包裹在外层的 <a> 标签的 href (V2EX 经常会将大图用 a 标签包裹)
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
      // 初次全量扫描
      scanAll();

      // 监听 DOM 变化 (兼容 ThreadTree 多页拉取及 HotRoom 高赞动态生成)
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
  // 7) 启动
  // =========================
  Daily.boot();

  if (isTopicPage()) {
    ThreadTree.boot();
    B64.boot();
    HotRoom.boot();
    ImgurProxy.boot(); // 启动代理模块
  }
})();
