// ==UserScript==
// @name         外链直接跳转（NodeSeek / 知乎）
// @namespace    https://github.com/
// @version      1.0.0
// @description  点击 NodeSeek 和知乎的外链时，跳过中间确认页，直接打开目标网站。
// @match        https://nodeseek.com/*
// @match        https://*.nodeseek.com/*
// @match        https://zhihu.com/*
// @match        https://*.zhihu.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const REDIRECT_RULES = [
    {
      hosts: new Set(['nodeseek.com', 'www.nodeseek.com']),
      path: '/jump',
      parameter: 'to',
    },
    {
      hosts: new Set(['link.zhihu.com']),
      path: '/',
      parameter: 'target',
    },
  ];

  function getDirectUrl(value, base = location.href) {
    let url;
    try {
      url = new URL(value, base);
    } catch (_) {
      return null;
    }

    const rule = REDIRECT_RULES.find(item =>
      item.hosts.has(url.hostname.toLowerCase()) && url.pathname === item.path
    );
    if (!rule) return null;

    const target = url.searchParams.get(rule.parameter);
    if (!target) return null;

    try {
      const directUrl = new URL(target);
      return ['http:', 'https:'].includes(directUrl.protocol) ? directUrl.href : null;
    } catch (_) {
      return null;
    }
  }

  // 如果已经进入中间页，尽早跳走，不让确认页面闪现或继续加载。
  const currentTarget = getDirectUrl(location.href);
  if (currentTarget) {
    location.replace(currentTarget);
    return;
  }

  function rewriteLink(link) {
    const directUrl = getDirectUrl(link.href);
    if (!directUrl) return;
    link.href = directUrl;
    link.removeAttribute('ping');
  }

  function rewriteLinks(root) {
    if (root instanceof HTMLAnchorElement) rewriteLink(root);
    if (root.querySelectorAll) root.querySelectorAll('a[href]').forEach(rewriteLink);
  }

  function start() {
    rewriteLinks(document);

    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          rewriteLink(mutation.target);
          continue;
        }
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) rewriteLinks(node);
        });
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  if (document.documentElement) start();
  else document.addEventListener('readystatechange', start, { once: true });
})();
