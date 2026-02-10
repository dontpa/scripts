// ==UserScript==
// @name         V2EX 自动签到（每日奖励）- 最优实现
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  自动领取 V2EX 每日登录奖励；每天最多尝试一次，解析更鲁棒，失败可重试
// @author       you
// @match        https://v2ex.com/*
// @match        https://www.v2ex.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=v2ex.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    dailyPage: '/mission/daily',
    // 随机延迟：更像人类，也给页面/登录态一点时间
    delayMinMs: 1500,
    delayMaxMs: 3800,
    // 每天最多尝试一次（成功/已领/失败都会记录；失败想立刻重试就手动清空存储或改 key）
    storeKey: 'v2ex_daily_check_ymd_v1',
    // 通知：你不想要通知就改 false
    notify: true,
  };

  const log = (...args) => console.log('[V2EX-Daily]', ...args);

  function ymdLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function notify(title, text) {
    if (!CFG.notify) return;
    try {
      GM_notification({ title, text, timeout: 4000 });
    } catch (_) {
      // 某些环境可能禁用 notification；忽略即可
    }
  }

  function isLoggedIn() {
    // 经验上：未登录时顶部有“登录”入口 /signin；已登录常见 signout 链接
    const hasSignOut = !!document.querySelector('a[href="/signout"]');
    const hasSignIn = !!document.querySelector('a[href="/signin"]');
    // 如果同时存在，优先认为已登录（偶发 DOM 重复/缓存）
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
    // 兼容中英文/不同措辞：宁可宽松一点，避免重复领取
    return (
      /已领取|已经领取|每日登录奖励已领取|redeemed|already redeemed|已完成/.test(text)
    );
  }

  function findRedeemUrl(doc) {
    // 1) 最稳：直接找 redeem 链接
    const a = doc.querySelector('a[href^="/mission/daily/redeem"]');
    if (a?.getAttribute('href')) return a.getAttribute('href');

    // 2) 其次：按钮 onclick 里 location.href='...'
    const btn = doc.querySelector('input[type="button"][onclick*="redeem"], input[value^="领取"][onclick]');
    if (btn) {
      const onclick = btn.getAttribute('onclick') || '';
      const m = onclick.match(/'([^']+)'/);
      if (m?.[1]) return m[1];
    }

    // 3) 兜底：全局扫一遍 onclick（少量页面结构变化时仍能命中）
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
    if (!isLoggedIn()) {
      log('Not logged in. Skip.');
      return;
    }

    const today = ymdLocal();
    const last = GM_getValue(CFG.storeKey, '');
    if (last === today) {
      log(`Already checked today (${today}). Skip.`);
      return;
    }

    // 先标记今日已尝试，避免多标签页/多次刷新导致重复请求
    GM_setValue(CFG.storeKey, today);

    await sleep(randInt(CFG.delayMinMs, CFG.delayMaxMs));

    log('Fetching daily mission page...');
    const html1 = await fetchText(CFG.dailyPage);
    const doc1 = parseHtml(html1);

    if (alreadyRedeemed(doc1)) {
      log('Already redeemed today.');
      notify('V2EX 签到', '今日奖励已领取（或已完成）');
      return;
    }

    const redeemUrl = findRedeemUrl(doc1);
    if (!redeemUrl) {
      // 可能是页面结构变了 / 任务入口隐藏 / 你被风控 / 未满足条件
      log('Redeem URL not found. Page structure may have changed.');
      notify('V2EX 签到', '未找到领取按钮/链接（可能结构变更）');
      return;
    }

    log('Redeeming via:', redeemUrl);
    const html2 = await fetchText(redeemUrl);
    const doc2 = parseHtml(html2);

    if (alreadyRedeemed(doc2) || /奖励/.test(doc2.body?.innerText || '')) {
      log('Redeem success (or confirmed).');
      notify('V2EX 签到', '领取成功 ✅');
    } else {
      // 不同返回页面可能不包含“已领取”字样，这里给一个保守提示
      log('Redeem request done, but confirmation text not detected.');
      notify('V2EX 签到', '已发起领取，请打开 /mission/daily 确认');
    }
  }

  run().catch(err => {
    // 如果出错：允许你今天再次刷新重试（把 key 清掉）
    log('Error:', err);
    GM_setValue(CFG.storeKey, ''); // 出错不算完成，清空以便重试
    notify('V2EX 签到', `失败：${err?.message || err}`);
  });
})();
