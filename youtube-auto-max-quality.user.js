// ==UserScript==
// @name         YouTube 自动最高画质 (Auto Max Quality)
// @name:zh-CN   YouTube 自动最高画质
// @namespace    https://github.com/yourname/youtube-max-quality
// @version      2.0.0
// @description  自动把 YouTube 视频切到可用的最高分辨率：支持画质上限、尊重手动切换、跳过悬停预览小窗、全屏内提示；兼容 Chrome / Firefox / Safari (Tampermonkey / Violentmonkey / Userscripts)
// @author       you
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  // =========================
  // 配置
  // =========================
  const STORE_KEY = 'yt_max_quality_settings_v1';
  const DEFAULTS = {
    enabled: true,
    ceiling: 'highres',   // 画质上限，highres = 不设限
    toast: true,          // 切换成功后在播放器里提示一次
    skipPreview: true,    // 跳过首页悬停预览的小窗播放器
    debug: false,
  };

  // YouTube 内部画质标识，rank 越大越清晰
  const QUALITIES = [
    { id: 'highres', label: '4320p', rank: 100 },
    { id: 'hd2880',  label: '2880p', rank: 90 },
    { id: 'hd2160',  label: '2160p', rank: 80 },
    { id: 'hd1440',  label: '1440p', rank: 70 },
    { id: 'hd1080',  label: '1080p', rank: 60 },
    { id: 'hd720',   label: '720p',  rank: 50 },
    { id: 'large',   label: '480p',  rank: 40 },
    { id: 'medium',  label: '360p',  rank: 30 },
    { id: 'small',   label: '240p',  rank: 20 },
    { id: 'tiny',    label: '144p',  rank: 10 },
  ];
  const RANK = new Map(QUALITIES.map(q => [q.id, q.rank]));
  const LABEL = new Map(QUALITIES.map(q => [q.id, q.label]));
  // 菜单里可循环选择的上限档位
  const CEILINGS = ['highres', 'hd2160', 'hd1440', 'hd1080', 'hd720'];

  // 播放器就绪是异步的：在这个时间窗内持续重试，超时后放弃（等下一次导航）
  const ATTEMPT_WINDOW_MS = 25000;
  // 设置成功后再复查一次，YouTube 偶尔会在起播后把画质打回 auto
  const VERIFY_DELAY_MS = 3000;
  const MAX_REAPPLY = 2;
  // 悬停预览 / 内嵌小窗，不值得为它拉满码率
  const PREVIEW_SELECTOR = 'ytd-video-preview, #inline-player, ytd-inline-player-renderer';

  const LOG_PREFIX = '[YT-MaxQuality]';

  // =========================
  // 设置存取
  // =========================
  // 有的管理器（Violentmonkey）把 GM_* 作为局部变量注入，不挂在 globalThis 上，
  // 所以只能用 typeof 直接探测标识符本身。
  const HAS = {
    getValue: typeof GM_getValue === 'function',
    setValue: typeof GM_setValue === 'function',
    registerMenu: typeof GM_registerMenuCommand === 'function',
    unregisterMenu: typeof GM_unregisterMenuCommand === 'function',
  };

  function loadSettings() {
    let raw = null;
    try {
      raw = HAS.getValue
        ? GM_getValue(STORE_KEY, null)
        : JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch (_) {}
    const settings = { ...DEFAULTS };
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (typeof raw[key] === typeof DEFAULTS[key]) settings[key] = raw[key];
      }
    }
    if (!RANK.has(settings.ceiling)) settings.ceiling = DEFAULTS.ceiling;
    return settings;
  }

  const SETTINGS = loadSettings();

  function saveSettings() {
    try {
      if (HAS.setValue) GM_setValue(STORE_KEY, { ...SETTINGS });
      else localStorage.setItem(STORE_KEY, JSON.stringify(SETTINGS));
    } catch (err) { console.warn(LOG_PREFIX, '设置保存失败', err); }
  }

  const log = (...args) => { if (SETTINGS.debug) console.log(LOG_PREFIX, ...args); };

  // =========================
  // 播放器访问
  // =========================
  // Firefox 的沙箱（Xray）会挡住页面在 DOM 节点上挂的方法，需要取原始对象。
  // Chrome / @grant none 下 wrappedJSObject 不存在，这里等价于原样返回。
  function unwrap(node) {
    try { return node?.wrappedJSObject || node; } catch (_) { return node; }
  }

  const isPreview = node => SETTINGS.skipPreview && !!node?.closest?.(PREVIEW_SELECTOR);

  /** @returns {{node: Element, api: any} | null} */
  function getPlayer() {
    const seen = new Set();
    const candidates = [
      document.getElementById('movie_player'),
      document.getElementById('shorts-player'),
      document.getElementById('player'),
      ...document.querySelectorAll('.html5-video-player'),
    ];
    for (const node of candidates) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (isPreview(node)) continue;
      const api = unwrap(node);
      if (typeof api?.getAvailableQualityLevels === 'function') return { node, api };
    }
    return null;
  }

  function videoIdOf(api) {
    try { return api.getVideoData?.()?.video_id || ''; } catch (_) { return ''; }
  }

  function currentQuality(api) {
    try { return api.getPlaybackQuality?.() || ''; } catch (_) { return ''; }
  }

  /** 在可用档位中挑出不超过上限的最高一档 */
  function pickQuality(levels) {
    const ceiling = RANK.get(SETTINGS.ceiling) ?? Infinity;
    let best = null, bestRank = -1;
    let fallback = null, fallbackRank = Infinity;
    for (const id of levels) {
      const rank = RANK.get(id);
      if (rank === undefined) continue;       // 'auto' 等非分辨率档位
      if (rank < fallbackRank) { fallbackRank = rank; fallback = id; }
      if (rank > ceiling) continue;
      if (rank > bestRank) { bestRank = rank; best = id; }
    }
    // 所有档位都高于上限时，退到可用列表里最低的一档
    return best || fallback;
  }

  // =========================
  // 提示条（挂在播放器内部，全屏时也可见）
  // =========================
  let styleInjected = false;
  function injectStyle() {
    if (styleInjected || !document.head) return;
    styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .ytmq-toast {
        position: absolute; top: 56px; left: 16px; z-index: 60;
        padding: 6px 12px; border-radius: 16px;
        background: rgba(0, 0, 0, 0.72); color: #fff;
        font-family: "YouTube Noto", Roboto, Arial, sans-serif;
        font-size: 12px; line-height: 1.4; letter-spacing: 0.2px;
        pointer-events: none; opacity: 0; transform: translateY(-4px);
        transition: opacity 0.22s ease, transform 0.22s ease;
      }
      .ytmq-toast.ytmq-visible { opacity: 1; transform: none; }
    `;
    document.head.appendChild(style);
  }

  let toastTimer = 0;
  function showToast(playerNode, text) {
    if (!SETTINGS.toast || !playerNode) return;
    injectStyle();
    let el = playerNode.querySelector(':scope > .ytmq-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ytmq-toast';
      playerNode.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(() => el.classList.add('ytmq-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('ytmq-visible'), 1800);
  }

  // =========================
  // 应用画质
  // =========================
  // 用户自己在播放器里选过画质的视频，之后一律不再干预
  const manualOverride = new Set();
  let state = { key: '', applied: false, reapplies: 0 };

  function resetStateFor(key) {
    if (state.key !== key) state = { key, applied: false, reapplies: 0 };
  }

  /** @returns {'applied'|'satisfied'|'retry'} */
  function apply(player) {
    const { node, api } = player;
    let levels;
    try { levels = api.getAvailableQualityLevels(); } catch (_) { return 'retry'; }
    // 元数据还没加载完时列表是空的
    if (!Array.isArray(levels) || !levels.length) return 'retry';

    const target = pickQuality(levels);
    if (!target) return 'retry';
    if (currentQuality(api) === target) return 'satisfied';

    try {
      // setPlaybackQualityRange 会锁住档位，不会被 YouTube 自动降级
      api.setPlaybackQualityRange?.(target, target);
      api.setPlaybackQuality?.(target);
    } catch (err) {
      log('设置画质出错', err);
      return 'retry';
    }
    log(`已切换 → ${target}（可选：${levels.join(', ')}）`);
    showToast(node, `已切换到 ${LABEL.get(target) || target}`);
    return 'applied';
  }

  // =========================
  // 重试调度（全局单例，不会叠加定时器）
  // =========================
  let timer = 0;
  let deadline = 0;
  let attempt = 0;

  function stop() {
    clearTimeout(timer);
    timer = 0;
  }

  function schedule(delay) {
    stop();
    timer = setTimeout(tick, delay);
  }

  function tick() {
    timer = 0;
    if (!SETTINGS.enabled) return;

    const player = getPlayer();
    if (!player) { retry(); return; }

    // 贴片广告用的是同一个播放器，没必要为广告拉满码率；等正片开始再处理
    if (player.node.classList.contains('ad-showing')) { retry(); return; }

    const key = videoIdOf(player.api) || 'unknown';
    resetStateFor(key);
    if (manualOverride.has(key)) { log('用户手动选择过画质，跳过', key); return; }

    if (state.applied) {
      // 复查：只有确实被打回更低画质时才补一次，避免和播放器反复拉锯
      const levels = (() => { try { return player.api.getAvailableQualityLevels() || []; } catch (_) { return []; } })();
      const target = pickQuality(levels);
      const now = currentQuality(player.api);
      const drifted = target && now && (RANK.get(now) ?? 0) < (RANK.get(target) ?? 0);
      if (!drifted || state.reapplies >= MAX_REAPPLY) return;
      state.reapplies++;
      state.applied = false;
      log(`画质被打回 ${now}，第 ${state.reapplies} 次补设`);
    }

    const result = apply(player);
    if (result === 'retry') { retry(); return; }
    state.applied = true;
    if (state.reapplies < MAX_REAPPLY) schedule(VERIFY_DELAY_MS);
  }

  function retry() {
    if (Date.now() > deadline) { log('超出重试窗口，等待下一次导航'); return; }
    attempt++;
    // 起步快、后面放缓，避免在长时间加载时空转
    schedule(Math.min(250 + attempt * 150, 1200));
  }

  /** 触发一轮尝试；同一时刻只会有一个调度在跑 */
  function run(reason) {
    if (!SETTINGS.enabled) { stop(); return; }
    log('触发：', reason);
    attempt = 0;
    deadline = Date.now() + ATTEMPT_WINDOW_MS;
    schedule(0);
  }

  // =========================
  // 事件绑定
  // =========================
  function bind() {
    // 媒体事件不冒泡，用捕获阶段在 document 上统一接收，避免逐个节点挂监听导致泄漏
    const onMedia = e => {
      const target = e.target;
      if (target?.tagName !== 'VIDEO' || isPreview(target)) return;
      run(e.type);
    };
    for (const type of ['loadstart', 'loadeddata', 'playing']) {
      document.addEventListener(type, onMedia, { capture: true, passive: true });
    }

    // YouTube 是 SPA：换视频不刷新页面
    for (const type of ['yt-navigate-finish', 'yt-player-updated']) {
      document.addEventListener(type, () => run(type), true);
    }
    window.addEventListener('popstate', () => run('popstate'));
    window.addEventListener('pageshow', () => run('pageshow'));

    // 用户自己在画质菜单里选过，就不再跟他抢。
    // 只认带分辨率文案的菜单项（"画质 自动(1080p)" 或 "1080p60 HD"），
    // 避免点字幕、播放速度等其它设置项时被误判。
    document.addEventListener('click', e => {
      const item = e.target?.closest?.('.ytp-menuitem, .ytp-quality-menu .ytp-menuitem-label');
      if (!item || !/\d{3,4}p/.test(item.textContent || '')) return;
      const player = getPlayer();
      const key = player ? (videoIdOf(player.api) || 'unknown') : '';
      if (!key) return;
      manualOverride.add(key);
      stop();
      log('检测到手动切换画质，停止干预', key);
    }, true);
  }

  // =========================
  // 油猴菜单
  // =========================
  const menuIds = [];
  function buildMenu() {
    if (!HAS.registerMenu) return;
    const canRefresh = HAS.unregisterMenu;
    if (menuIds.length) {
      if (!canRefresh) return;            // 无法注销时只注册一次，避免菜单项重复堆叠
      while (menuIds.length) {
        try { GM_unregisterMenuCommand(menuIds.pop()); } catch (_) {}
      }
    }
    const add = (label, handler) => {
      try { menuIds.push(GM_registerMenuCommand(label, handler)); } catch (_) {}
    };
    const mark = on => (on ? '✅' : '⬜️');

    add(`${mark(SETTINGS.enabled)} 自动最高画质`, () => {
      SETTINGS.enabled = !SETTINGS.enabled;
      saveSettings();
      buildMenu();
      if (SETTINGS.enabled) run('menu'); else stop();
    });
    add(`🎚 画质上限：${SETTINGS.ceiling === 'highres' ? '不限' : LABEL.get(SETTINGS.ceiling)}`, () => {
      const next = (CEILINGS.indexOf(SETTINGS.ceiling) + 1) % CEILINGS.length;
      SETTINGS.ceiling = CEILINGS[next];
      saveSettings();
      buildMenu();
      state = { key: '', applied: false, reapplies: 0 };
      run('ceiling-changed');
    });
    add(`${mark(SETTINGS.toast)} 切换时显示提示`, () => {
      SETTINGS.toast = !SETTINGS.toast;
      saveSettings();
      buildMenu();
    });
    add(`${mark(SETTINGS.skipPreview)} 跳过悬停预览小窗`, () => {
      SETTINGS.skipPreview = !SETTINGS.skipPreview;
      saveSettings();
      buildMenu();
    });
  }

  // =========================
  // 启动
  // =========================
  function init() {
    bind();
    buildMenu();
    run('init');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
