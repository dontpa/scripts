// ==UserScript==
// @name         V2EX 帖子楼层重排 (Hacker News Style) - 紧凑极简版
// @namespace    http://tampermonkey.net/
// @version      1.10
// @description  全量加载多页，优先使用@匹配以解决删帖导致的楼层错位，极简 Reddit 风格，舒适阅读
// @author       Gemini
// @match        https://v2ex.com/t/*
// @match        https://www.v2ex.com/t/*
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置样式 ---
    const STYLES = `
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
    `;

    GM_addStyle(STYLES);

    // --- 核心逻辑 ---

    const topicId = window.location.pathname.match(/\/t\/(\d+)/)?.[1];
    if (!topicId) return;

    const STORAGE_KEY = `v2_last_read_${topicId}`;

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
            id: replyId,
            author: authorEl.innerText,
            floor: parseInt(floorEl.innerText, 10),
            contentHtml: contentEl.innerHTML,
            textContent: contentEl.innerText,
            avatar: avatarEl ? avatarEl.src : '', 
            children: []
        };
    }

    function extractRepliesFromDoc(doc) {
        const cells = Array.from(doc.querySelectorAll('div.cell[id^="r_"]'));
        return cells.map(parseReplyCell).filter(r => r !== null);
    }

    /**
     * 推测父级楼层 - v1.10 逻辑修正版
     */
    function inferParent(reply, allReplies) {
        // 1. 优先匹配 @用户名
        // V2EX 有删帖机制会导致楼层号发生错位偏移，但 @用户名 是硬编码在文本里的，绝不会错位
        const mentionMatch = reply.contentHtml.match(/\/member\/([\w]+)/);
        if (mentionMatch) {
            const targetUser = mentionMatch[1];
            // 倒序遍历，寻找该用户距离当前楼层最近的一次发言
            for (let i = allReplies.length - 1; i >= 0; i--) {
                const r = allReplies[i];
                if (r.floor < reply.floor && r.author.toLowerCase() === targetUser.toLowerCase()) {
                    return r; 
                }
            }
        }

        // 2. 如果没有 @用户名，再去尝试兜底匹配 #楼层号
        const floorMatch = reply.textContent.match(/#(\d+)/);
        if (floorMatch) {
            const targetFloor = parseInt(floorMatch[1], 10);
            if (targetFloor < reply.floor) {
                const parent = allReplies.find(r => r.floor === targetFloor);
                if (parent) return parent;
            }
        }
        
        return null;
    }

    function renderTree(flatReplies, container) {
        const replyMap = new Map();
        const roots = [];

        flatReplies.forEach(r => {
            replyMap.set(r.floor, r);
            r.children = [];
        });

        flatReplies.forEach(r => {
            const parent = inferParent(r, flatReplies);
            if (parent) {
                parent.children.push(r);
            } else {
                roots.push(r);
            }
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

    function handleReadStatus(replies) {
        const storedValue = localStorage.getItem(STORAGE_KEY);
        let maxFloor = 0;

        replies.forEach(r => {
            if (r.floor > maxFloor) maxFloor = r.floor;
        });

        if (storedValue === null) {
            localStorage.setItem(STORAGE_KEY, maxFloor);
            return;
        }

        const lastReadFloor = parseInt(storedValue, 10);

        replies.forEach(r => {
            if (r.floor > lastReadFloor) {
                r.element.classList.add('reply-new');
                const authorContainer = r.element.querySelector('strong');
                if (authorContainer) {
                    const dot = document.createElement('span');
                    dot.className = 'new-dot';
                    dot.title = 'New reply';
                    authorContainer.prepend(dot);
                }
            }
        });
        localStorage.setItem(STORAGE_KEY, maxFloor);
    }

    async function init() {
        const replyBox = Array.from(document.querySelectorAll('.box')).find(b => b.querySelector('div[id^="r_"]'));
        if (!replyBox) return;

        const loadingBar = document.createElement('div');
        loadingBar.id = 'v2ex-loading-bar';
        loadingBar.innerText = '加载中...';
        replyBox.parentNode.insertBefore(loadingBar, replyBox);

        let totalPages = 1;
        const pageInput = document.querySelector('.page_input');
        if (pageInput) {
            totalPages = parseInt(pageInput.max, 10);
        } else {
            const pageLinks = document.querySelectorAll('a.page_normal');
            if (pageLinks.length > 0) {
                totalPages = parseInt(pageLinks[pageLinks.length - 1].innerText, 10);
            }
        }

        let allReplies = [];
        const firstPageReplies = extractRepliesFromDoc(document);
        allReplies = allReplies.concat(firstPageReplies);

        if (totalPages > 1) {
            const fetchPromises = [];
            for (let p = 1; p <= totalPages; p++) {
                const currentP = new URLSearchParams(window.location.search).get('p');
                if (parseInt(currentP) === p || (!currentP && p === 1)) continue;

                fetchPromises.push(fetch(`${location.pathname}?p=${p}`)
                    .then(res => res.text())
                    .then(html => {
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        return extractRepliesFromDoc(doc);
                    })
                );
            }
            const otherPagesReplies = await Promise.all(fetchPromises);
            otherPagesReplies.forEach(list => allReplies = allReplies.concat(list));
        }

        allReplies.sort((a, b) => a.floor - b.floor);
        document.querySelectorAll('.page_input, .page_current, .page_normal').forEach(el => el.closest('div')?.remove());

        renderTree(allReplies, replyBox);
        handleReadStatus(allReplies);
        loadingBar.remove();
        document.querySelectorAll('a[name="last_page"]').forEach(e => e.remove());
    }

    init();

})();