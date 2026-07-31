// ==UserScript==
// @name         NodeSeek 自动签到（试试手气）
// @namespace    https://www.nodeseek.com/
// @version      1.0.1
// @description  访问 NodeSeek 时自动前往隐藏签到页，并选择“试试手气”。
// @author       you
// @match        https://www.nodeseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    boardPath: '/board',
    doneKey: 'nodeseek_lucky_checkin_done_v1',
    lockKey: 'nodeseek_lucky_checkin_lock_v1',
    timeZone: 'Asia/Shanghai',
    controlWaitMs: 30_000,
    resultWaitMs: 15_000,
    iframeLifetimeMs: 45_000,
  };

  const log = (...args) => console.log('[NodeSeek Check-in]', ...args);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function getValue(key, fallback) {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function setValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
    } catch (error) {
      log('保存状态失败：', error);
    }
  }

  function today() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: CONFIG.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch (_) {
      return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
  }

  function notify(text) {
    log(text);
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title: 'NodeSeek 自动签到', text, timeout: 5000 });
      }
    } catch (_) {}
  }

  function exactButton(label) {
    return Array.from(document.querySelectorAll('button')).find(
      button => button.textContent.trim() === label && !button.disabled,
    );
  }

  function pageResult() {
    const text = document.body?.innerText || '';
    const result = text.match(/今日签到获得鸡腿\s*(\d+)\s*个[^\n]*/);
    if (result) return result[0].trim();

    const modalResult = text.match(/今天的签到收益是\s*(\d+)\s*个鸡腿/);
    return modalResult ? `今日签到获得鸡腿${modalResult[1]}个` : '';
  }

  async function waitUntil(check, timeoutMs, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  async function acquireDailyLock(date) {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const current = getValue(CONFIG.lockKey, null);

    if (current?.date === date && Date.now() - current.at < 2 * 60_000) return false;

    setValue(CONFIG.lockKey, { date, at: Date.now(), nonce });
    await sleep(120);
    return getValue(CONFIG.lockKey, null)?.nonce === nonce;
  }

  function closeSuccessDialog() {
    const ok = exactButton('OK');
    if (ok) ok.click();
  }

  async function checkInOnBoard() {
    const date = today();
    if (getValue(CONFIG.doneKey, '') === date) return;

    const existingResult = await waitUntil(
      () => pageResult() || exactButton('试试手气'),
      CONFIG.controlWaitMs,
    );

    if (!existingResult) {
      log('未找到签到区；请确认账号仍处于登录状态。');
      return;
    }

    if (typeof existingResult === 'string') {
      setValue(CONFIG.doneKey, date);
      log(existingResult);
      return;
    }

    // 加一点随机延迟，并用共享锁降低多个 NodeSeek 标签页同时签到的概率。
    await sleep(randomInt(900, 2400));
    if (!(await acquireDailyLock(date))) return;

    const button = exactButton('试试手气');
    const containerText = button?.parentElement?.textContent || '';
    if (!button || !containerText.includes('今日还未签到')) return;

    button.click();

    const result = await waitUntil(pageResult, CONFIG.resultWaitMs);
    if (!result) {
      notify('已点击“试试手气”，但暂未读取到签到结果，请打开签到页确认。');
      return;
    }

    setValue(CONFIG.doneKey, date);
    closeSuccessDialog();
    notify(result);
  }

  function openHiddenBoard() {
    if (getValue(CONFIG.doneKey, '') === today()) return;

    const iframe = document.createElement('iframe');
    iframe.src = CONFIG.boardPath;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    // 必须明确指定 top/left。只有 position:fixed 而没有定位坐标时，iframe
    // 仍会使用文档末尾的静态位置；签到弹窗自动聚焦按钮时可能把主页面滚到底部。
    iframe.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:1px',
      'height:1px',
      'opacity:0',
      'overflow:hidden',
      'pointer-events:none',
      'border:0',
      'z-index:-2147483648',
    ].join(';');
    document.documentElement.appendChild(iframe);
    window.setTimeout(() => iframe.remove(), CONFIG.iframeLifetimeMs);
  }

  const onBoard = location.pathname.replace(/\/+$/, '') === CONFIG.boardPath;

  if (onBoard) {
    checkInOnBoard().catch(error => log('签到失败：', error));
  } else if (window.top === window.self) {
    window.setTimeout(openHiddenBoard, randomInt(1500, 4000));
  }
})();
