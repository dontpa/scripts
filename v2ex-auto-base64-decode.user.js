// ==UserScript==
// @name         V2EX Base64 自动解码（兼容楼层重排/多页加载）
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  扫描主题正文与回复中的 Base64 字符串，自动解码并内联展示（支持复制/打开），兼容动态加载/重排
// @match        https://v2ex.com/t/*
// @match        https://www.v2ex.com/t/*
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // ===== 配置 =====
  const MAX_LEN = 4096;          // 过长不解，避免卡顿
  const URL_ONLY = true;         // true=只展示解码后像 URL 的内容
  const TARGET_SELECTORS = ['.topic_content', '.reply_content']; // 只扫这两类
  const SKIP_IN_LINK = true;     // 不处理 <a> 内文本，避免破坏链接

  const B64_RE = /(^|[^A-Za-z0-9+/_-])([A-Za-z0-9+/_-]{16,}={0,2})(?=[^A-Za-z0-9+/_-]|$)/g;

  // ===== 样式（极简）=====
  const style = document.createElement('style');
  style.textContent = `
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
  `;
  document.head.appendChild(style);

  // ===== Base64 decode =====
  function normalizeBase64(s) {
    let x = s.replace(/-/g, '+').replace(/_/g, '/').trim();
    const pad = x.length % 4;
    if (pad) x += '='.repeat(4 - pad);
    return x;
  }

  function tryDecodeBase64(raw) {
    if (!raw || raw.length < 16 || raw.length > MAX_LEN) return null;

    const norm = normalizeBase64(raw);
    let bin;
    try {
      bin = atob(norm);
    } catch {
      return null;
    }

    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

    // 控制字符过滤
    const bad = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
    if (bad > 0) return null;

    if (URL_ONLY) {
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
    label.textContent = decoded; // ✅ 没有 decoded:
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
    if (SKIP_IN_LINK && p.closest('a')) return true;
    // 已经插过 badge 的节点，不再处理
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

    // 防重复：同一块内容只扫一次（如果你有“编辑内容”的脚本，可移除这个限制）
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
    for (const sel of TARGET_SELECTORS) {
      document.querySelectorAll(sel).forEach(scanElement);
    }
  }

  // ===== 关键：监听 DOM 更新，兼容你“多页加载+重排”脚本 =====
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

  function startObserver() {
    const root = document.querySelector('#Main') || document.body;
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  // init
  scanAll();
  startObserver();
})();
