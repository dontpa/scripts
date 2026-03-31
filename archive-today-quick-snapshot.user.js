// ==UserScript==
// @name         Archive Today — Quick Snapshot
// @namespace    https://archive.today/
// @version      1.1.0
// @description  Send the current page URL to archive.today and jump to its latest snapshot.
// @author       You
// @match        *://*/*
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

  // ─── Navigate a tab reference to a URL ───────────────────────────────────
  // `tabRef` is the object returned by window.open() — kept alive from the
  // synchronous part of the click handler so Mobile Safari doesn't block it.
  function navigateTo(tabRef, url) {
    if (tabRef && !tabRef.closed) {
      tabRef.location.href = url;
    } else {
      // Fallback: if the reference was lost, try a plain window.open
      window.open(url, "_blank");
    }
  }

  // ─── Core logic ───────────────────────────────────────────────────────────
  function handleClick() {
    const pageUrl = window.location.href;

    // ↓ CRITICAL FOR MOBILE SAFARI ↓
    // window.open() must be called synchronously inside the user-gesture handler.
    // Any call made inside an async callback (XHR onload, setTimeout, Promise)
    // is treated as a popup by iOS Safari and silently blocked.
    // We open a blank tab NOW, then steer it to the right URL once we know it.
    const newTab = window.open("", "_blank");

    setLoading(true);

    const newestUrl = `${ARCHIVE_HOST}/newest/${pageUrl}`;

    GM_xmlhttpRequest({
      method: "GET",
      url: newestUrl,
      onload(response) {
        const finalUrl = response.finalUrl || response.responseURL || newestUrl;
        const isSnapshot =
          /archive\.(today|ph|is|fo|li)\/[a-zA-Z0-9]{4,}/.test(finalUrl) &&
          !finalUrl.includes("/submit") &&
          !finalUrl.includes("/newest");

        if (response.status === 200 && isSnapshot) {
          navigateTo(newTab, finalUrl);
          setLoading(false);
        } else {
          submitAndRedirect(pageUrl, newTab);
        }
      },
      onerror() {
        submitAndRedirect(pageUrl, newTab);
      },
    });
  }

  function submitAndRedirect(pageUrl, newTab) {
    const submitUrl = `${ARCHIVE_HOST}/submit/`;

    GM_xmlhttpRequest({
      method: "POST",
      url: submitUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: `url=${encodeURIComponent(pageUrl)}&anyway=1`,
      onload(response) {
        const snapshotUrl = response.finalUrl || response.responseURL;
        const isSnapshot =
          snapshotUrl &&
          /archive\.(today|ph|is|fo|li)\/[a-zA-Z0-9]{4,}/.test(snapshotUrl) &&
          !snapshotUrl.includes("/submit");

        const dest = isSnapshot
          ? snapshotUrl
          : `${submitUrl}?url=${encodeURIComponent(pageUrl)}`;

        navigateTo(newTab, dest);
        setLoading(false);
      },
      onerror() {
        navigateTo(newTab, `${ARCHIVE_HOST}/submit/?url=${encodeURIComponent(pageUrl)}`);
        setLoading(false);
      },
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  injectStyles();
  createButton();
})();
