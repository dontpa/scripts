// ==UserScript==
// @name         YouTube 自动最高画质 (Auto Max Quality)
// @name:zh-CN   YouTube 自动最高画质
// @namespace    https://github.com/yourname/youtube-max-quality
// @version      1.0.0
// @description  自动将 YouTube 视频切换到当前可用的最高分辨率，兼容 Chrome / Firefox / Safari (Tampermonkey / Greasemonkey / Userscripts)
// @author       you
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://www.youtube-nocookie.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const LOG_PREFIX = '[YT-MaxQuality]';
    const log = (...args) => console.log(LOG_PREFIX, ...args);

    // YouTube 内部画质标识，从高到低
    const QUALITY_PRIORITY = [
        'highres', // 4320p (8K)
        'hd2880',  // 2880p (5K)
        'hd2160',  // 2160p (4K)
        'hd1440',  // 1440p (2K)
        'hd1080',  // 1080p
        'hd720',   //  720p
        'large',   //  480p
        'medium',  //  360p
        'small',   //  240p
        'tiny'     //  144p
    ];

    /**
     * 获取播放器实例（桌面端 / 移动端 / 兜底）
     * YouTube 把播放器 API 直接挂在 DOM 节点上，需要拿到那个节点
     */
    function getPlayer() {
        const desktop = document.getElementById('movie_player');
        if (desktop && typeof desktop.getAvailableQualityLevels === 'function') {
            return desktop;
        }
        const mobile = document.getElementById('player');
        if (mobile && typeof mobile.getAvailableQualityLevels === 'function') {
            return mobile;
        }
        // 兜底：在所有 html5-video-player 节点里找
        const candidates = document.querySelectorAll('.html5-video-player');
        for (const node of candidates) {
            if (typeof node.getAvailableQualityLevels === 'function') {
                return node;
            }
        }
        return null;
    }

    /**
     * 把视频画质拉到最高
     * 返回 true 表示成功（或已经是最高），false 表示需要重试
     */
    function setMaxQuality() {
        const player = getPlayer();
        if (!player) return false;

        let levels;
        try {
            levels = player.getAvailableQualityLevels();
        } catch (e) {
            return false;
        }

        if (!Array.isArray(levels) || levels.length === 0) {
            // 视频还没加载完，画质列表是空的
            return false;
        }

        // 找出可用列表里优先级最高的
        let target = null;
        for (const q of QUALITY_PRIORITY) {
            if (levels.includes(q)) {
                target = q;
                break;
            }
        }
        // 极端兜底：直接用列表第一项（YouTube 返回的列表本来就是从高到低）
        if (!target) target = levels[0];

        try {
            const current = typeof player.getPlaybackQuality === 'function'
                ? player.getPlaybackQuality()
                : null;

            if (current === target) {
                return true; // 已经是最高，跳过
            }

            // 优先用 setPlaybackQualityRange（较新且稳定，能锁住画质，不被 YouTube 自动降级）
            if (typeof player.setPlaybackQualityRange === 'function') {
                player.setPlaybackQualityRange(target, target);
            }
            // 兼容旧方法
            if (typeof player.setPlaybackQuality === 'function') {
                player.setPlaybackQuality(target);
            }

            log(`已切换画质 → ${target}（可选：${levels.join(', ')}）`);
            return true;
        } catch (e) {
            log('设置画质出错:', e);
            return false;
        }
    }

    /**
     * 重试包装
     * 视频元数据是异步加载的，刚进页面时 getAvailableQualityLevels() 可能返回空
     * 所以隔一段时间重试，直到成功或超出最大次数
     */
    function applyWithRetry(maxAttempts = 30, intervalMs = 500) {
        let attempts = 0;
        const timer = setInterval(() => {
            attempts += 1;
            if (setMaxQuality() || attempts >= maxAttempts) {
                clearInterval(timer);
            }
        }, intervalMs);
    }

    /**
     * 给 <video> 元素挂事件
     * 切换视频时 YouTube 经常复用同一个 <video> 节点，loadeddata / playing 是好时机
     */
    function attachVideoListeners() {
        const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (!video || video.dataset.maxQualityHooked === '1') return;
        video.dataset.maxQualityHooked = '1';

        const handler = () => applyWithRetry(10, 400);
        // 用 passive 减少事件性能开销，对兼容性也最友好
        const opts = { passive: true };
        video.addEventListener('loadeddata', handler, opts);
        video.addEventListener('playing', handler, opts);
        video.addEventListener('canplay', handler, opts);
    }

    /**
     * YouTube 是 SPA，点击新视频不刷新页面
     * 监听其自定义事件 yt-navigate-finish，并兜底 popstate / pageshow
     */
    function bindNavigation() {
        const onNav = () => {
            applyWithRetry();
            // 视频节点可能被替换，延迟重新挂监听
            setTimeout(attachVideoListeners, 1000);
        };
        document.addEventListener('yt-navigate-finish', onNav);
        window.addEventListener('popstate', onNav);
        window.addEventListener('pageshow', onNav);
    }

    function init() {
        log('脚本已启动');
        bindNavigation();
        attachVideoListeners();
        applyWithRetry();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
