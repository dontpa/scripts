// ==UserScript==
// @name         V2EX 高赞回复阅览室 - 宽屏沉浸版 (V3.5)
// @namespace    http://tampermonkey.net/
// @version      3.5
// @description  更宽的阅读视野，更紧凑的顶部间距。无标题、点击背景关闭。
// @author       Gemini Design
// @match        https://v2ex.com/t/*
// @match        https://www.v2ex.com/t/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // --- 1. 样式定义 (CSS) ---
  const styles = `
        /* 按钮样式：保持不变 */
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

        /* 遮罩层 */
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

        /* 容器 - 宽度调整区 */
        .hot-container {
            width: 92%;              /* 在小屏幕上占比更多 */
            max-width: 1000px;       /* 【调整】增加最大宽度 (原800px) */
            margin: 30px auto 80px auto; /* 【调整】减小顶部间距 (原60px) */
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.08);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            overflow: hidden;
            padding: 0;
        }

        /* 列表项 */
        .hot-card {
            background: #fff;
            padding: 14px 24px; /* 【调整】稍微增加一点内部左右边距，因为整体变宽了 */
            border-bottom: 1px solid #f0f0f0;
            display: flex;
            flex-direction: column;
            transition: background 0.1s;
        }
        .hot-card:last-child { border-bottom: none; }
        .hot-card:hover { background: #fafafa; }

        /* 排名标记 (左侧细条) */
        .rank-1 { border-left: 3px solid #faad14; background: linear-gradient(90deg, #fffdf5 0%, #fff 100%); }
        .rank-2 { border-left: 3px solid #ccc; }
        .rank-3 { border-left: 3px solid #d48806; }

        /* 头部行 */
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

        /* 点赞数 */
        .likes-pill { font-size: 12px; font-weight: 600; padding: 0 6px; }
        .rank-1 .likes-pill { color: #faad14; }
        .rank-normal .likes-pill { color: #ff6b6b; opacity: 0.8; }

        /* 内容区 */
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

        /* 滚动条 */
        #hot-overlay::-webkit-scrollbar { width: 4px; }
        #hot-overlay::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
    `;

  const styleSheet = document.createElement("style");
  styleSheet.innerText = styles;
  document.head.appendChild(styleSheet);

  // --- 2. 逻辑部分 ---
  function extractComments() {
    const comments = [];
    try {
      const cells = document.querySelectorAll('.cell[id^="r_"]');
      cells.forEach((cell) => {
        try {
          const smallFades = cell.querySelectorAll(".small.fade");
          let likes = 0;
          for (let span of smallFades) {
            const text = span.innerText;
            if (text.match(/(?:♥|❤️)\s*(\d+)/)) {
              likes = parseInt(text.match(/(?:♥|❤️)\s*(\d+)/)[1], 10);
              break;
            }
            const heartImg = span.querySelector('img[alt="❤️"]');
            if (heartImg && text.trim().length > 0) {
              likes = parseInt(text.trim(), 10);
              break;
            }
          }

          if (likes > 0) {
            comments.push({
              id: cell.id,
              likes: likes,
              avatar: cell.querySelector("img.avatar")?.src || "",
              username:
                cell.querySelector("strong > a")?.innerText || "Unknown",
              userUrl: cell.querySelector("strong > a")?.href || "#",
              time: cell.querySelector(".ago")?.innerText || "",
              contentHtml:
                cell.querySelector(".reply_content")?.innerHTML || "",
              floor: cell.querySelector(".no")?.innerText || "#",
            });
          }
        } catch (e) {
          console.error(e);
        }
      });
    } catch (e) {
      console.error(e);
    }
    return comments.sort((a, b) => b.likes - a.likes);
  }

  function buildUI(comments) {
    const old = document.getElementById("hot-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "hot-overlay";

    let cardsHtml = "";
    comments.forEach((c, index) => {
      let rankClass = "rank-normal";
      if (index === 0) rankClass = "rank-1";
      else if (index === 1) rankClass = "rank-2";
      else if (index === 2) rankClass = "rank-3";

      const jumpScript = `
                document.getElementById('hot-overlay').classList.remove('active');
                setTimeout(()=> document.getElementById('${c.id}').scrollIntoView({behavior:'smooth', block:'center'}), 300);
            `;

      cardsHtml += `
                <div class="hot-card ${rankClass}">
                    <div class="card-header-row">
                        <img src="${c.avatar}" class="user-avatar">
                        <a href="${c.userUrl}" target="_blank" class="user-name">${c.username}</a>
                        <div class="floor-tag" onclick="${jumpScript}" title="跳转">${c.floor}</div>
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

    overlay.innerHTML = `
            <div class="hot-container">
                ${cardsHtml}
            </div>
        `;

    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.remove("active");
      setTimeout(() => {
        if (!overlay.classList.contains("active")) overlay.remove();
      }, 200);
    };

    // 点击背景关闭
    overlay.onclick = (e) => {
      if (e.target === overlay) close();
    };

    // ESC 关闭
    document.onkeydown = (e) => {
      if (e.key === "Escape") close();
    };

    return overlay;
  }

  function init() {
    const topicHeader = document.querySelector("#Main .header h1");
    const boxHeader = document.querySelector("#Main .box .header");

    const target = topicHeader || boxHeader;

    if (target && !document.getElementById("v2ex-hot-btn")) {
      const btn = document.createElement("span");
      btn.id = "v2ex-hot-btn";
      btn.innerText = "高赞";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const overlay = buildUI(extractComments());
        requestAnimationFrame(() => overlay.classList.add("active"));
      };

      target.appendChild(btn);
    }
  }

  setTimeout(init, 500);
})();
