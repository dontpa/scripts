// ==UserScript==
// @name         Archive Today — Quick Snapshot
// @namespace    https://archive.today/
// @version      1.2.0
// @description  Send the current page URL to archive.today and navigate to its latest snapshot.
// @author       You
// @match        *://*/*
// @exclude      *://archive.today/*
// @exclude      *://archive.ph/*
// @exclude      *://archive.is/*
// @exclude      *://archive.fo/*
// @exclude      *://archive.li/*
// @grant        GM_xmlhttpRequest
// @connect      archive.today
// @connect      archive.ph
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─── Config ───────────────────────────────────────────────────────────────
  const ARCHIVE_HOST = "https://archive.today";
  const BTN_ID       = "__archive_today_btn__";
  const STYLE_ID     = "__archive_today_style__";

  // ─── Inject button styles ─────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BTN_ID} {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 2147483647;
        width: 32px;
        height: 32px;
        padding: 0;
        background: #1a1a1a;
        color: #f0f0f0;
        font-size: 16px;
        line-height: 1;
        border: none;
        border-radius: 6px;
        box-shadow: 0 2px 8px rgba(0,0,0,.4);
        cursor: pointer;
        transition: background .15s, transform .1s, opacity .2s;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #${BTN_ID}:hover   { background: #333; transform: translateY(-1px); }
      #${BTN_ID}:active  { transform: translateY(0); }
      #${BTN_ID}.loading { opacity: .5; pointer-events: none; }
    `;
    document.head.appendChild(style);
  }

  // ─── Create floating button ───────────────────────────────────────────────
  function createButton() {
    if (document.getElementById(BTN_ID)) return;
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.textContent = "🗃";
    btn.title = "Archive this page on archive.today";
    btn.addEventListener("click", handleClick);
    document.body.appendChild(btn);
  }

  function setLoading(on) {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.classList.toggle("loading", on);
  }

  // ─── Navigate current tab ─────────────────────────────────────────────────
  // Since we're staying in the same tab, no popup-blocker concerns at all.
  // Just set window.location.href directly — works on every platform.
  function navigateTo(url) {
    window.location.href = url;
  }

  // ─── Core logic ───────────────────────────────────────────────────────────
  function handleClick() {
    // Capture the page URL now — once we navigate away it'll be gone.
    const pageUrl = window.location.href;

    setLoading(true);

    GM_xmlhttpRequest({
      method: "GET",
      url: `${ARCHIVE_HOST}/newest/${pageUrl}`,
      onload(response) {
        const finalUrl = response.finalUrl || response.responseURL || "";
        const isSnapshot =
          /archive\.(today|ph|is|fo|li)\/[a-zA-Z0-9]{4,}/.test(finalUrl) &&
          !finalUrl.includes("/submit") &&
          !finalUrl.includes("/newest");

        if (response.status === 200 && isSnapshot) {
          navigateTo(finalUrl);
        } else {
          submitAndNavigate(pageUrl);
        }
      },
      onerror() {
        submitAndNavigate(pageUrl);
      },
    });
  }

  function submitAndNavigate(pageUrl) {
    const submitUrl = `${ARCHIVE_HOST}/submit/`;

    GM_xmlhttpRequest({
      method: "POST",
      url: submitUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: `url=${encodeURIComponent(pageUrl)}&anyway=1`,
      onload(response) {
        const snapshotUrl = response.finalUrl || response.responseURL || "";
        const isSnapshot =
          /archive\.(today|ph|is|fo|li)\/[a-zA-Z0-9]{4,}/.test(snapshotUrl) &&
          !snapshotUrl.includes("/submit");

        navigateTo(isSnapshot
          ? snapshotUrl
          : `${submitUrl}?url=${encodeURIComponent(pageUrl)}`
        );
      },
      onerror() {
        navigateTo(`${ARCHIVE_HOST}/submit/?url=${encodeURIComponent(pageUrl)}`);
      },
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  injectStyles();
  createButton();
})();
