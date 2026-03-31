// ==UserScript==
// @name         Archive Today — Quick Snapshot
// @namespace    https://archive.today/
// @version      1.0.0
// @description  Send the current page URL to archive.today and jump to its latest snapshot.
// @author       You
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      archive.today
// @connect      archive.ph
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─── Config ───────────────────────────────────────────────────────────────
  const ARCHIVE_HOST = "https://archive.today";   // also works with archive.ph / archive.is
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
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 9px 14px;
        background: #1a1a1a;
        color: #f0f0f0;
        font: 600 13px/1 system-ui, sans-serif;
        border: none;
        border-radius: 8px;
        box-shadow: 0 4px 14px rgba(0,0,0,.35);
        cursor: pointer;
        transition: background .15s, transform .1s, opacity .2s;
        text-decoration: none;
      }
      #${BTN_ID}:hover   { background: #333; transform: translateY(-1px); }
      #${BTN_ID}:active  { transform: translateY(0); }
      #${BTN_ID}.loading { opacity: .7; pointer-events: none; }
      #${BTN_ID} .icon   { font-size: 15px; }
      #${BTN_ID} .label  { letter-spacing: .2px; }
      #${BTN_ID} .status { font-size: 11px; opacity: .75; }
    `;
    document.head.appendChild(style);
  }

  // ─── Create floating button ───────────────────────────────────────────────
  function createButton() {
    if (document.getElementById(BTN_ID)) return;

    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.innerHTML = `<span class="icon">🗃️</span><span class="label">Archive</span>`;
    btn.title = "Send to archive.today and open the latest snapshot";
    btn.addEventListener("click", handleClick);
    document.body.appendChild(btn);
  }

  // ─── State helpers ────────────────────────────────────────────────────────
  function setStatus(text, loading = false) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.innerHTML = `<span class="icon">🗃️</span><span class="label">Archive</span><span class="status">${text}</span>`;
    btn.classList.toggle("loading", loading);
  }

  function resetButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.innerHTML = `<span class="icon">🗃️</span><span class="label">Archive</span>`;
    btn.classList.remove("loading");
  }

  // ─── Core logic ───────────────────────────────────────────────────────────
  function handleClick() {
    const pageUrl = window.location.href;

    // First, try to fetch the newest existing snapshot.
    // archive.today/newest/<url> redirects to the latest snapshot if one exists,
    // or returns a 404 / redirect to the submit page if none exists.
    const newestUrl = `${ARCHIVE_HOST}/newest/${pageUrl}`;

    setStatus("Checking…", true);

    GM_xmlhttpRequest({
      method: "GET",
      url: newestUrl,
      // Follow redirects so we land on the actual snapshot URL (or submit page).
      // Most userscript engines expose the final URL via response.finalUrl.
      onload(response) {
        const finalUrl = response.finalUrl || response.responseURL || newestUrl;

        // If archive.today redirected us to a real snapshot, open it.
        // Snapshots have the form: https://archive.today/<hash>
        const isSnapshot = /archive\.(today|ph|is|fo|li)\/[a-zA-Z0-9]{4,}/.test(finalUrl) &&
                           !finalUrl.includes("/submit") &&
                           !finalUrl.includes("/newest");

        if (response.status === 200 && isSnapshot) {
          setStatus("Opening…", true);
          GM_openInTab(finalUrl, { active: true });
          setTimeout(resetButton, 1500);
        } else {
          // No snapshot yet — submit the page for archiving.
          submitAndRedirect(pageUrl);
        }
      },
      onerror() {
        // Network error or blocked — fall back to a direct submit redirect.
        submitAndRedirect(pageUrl);
      },
    });
  }

  /**
   * Submit the URL to archive.today for archiving.
   * archive.today will save the page and then redirect to the new snapshot.
   * We open the submit URL directly; archive.today will redirect the user
   * to the freshly-created snapshot automatically.
   */
  function submitAndRedirect(pageUrl) {
    setStatus("Submitting…", true);

    // POST to archive.today/submit/ with the target URL.
    // We open the submit page in a new tab so the redirect lands there.
    const submitUrl = `${ARCHIVE_HOST}/submit/`;

    GM_xmlhttpRequest({
      method: "POST",
      url: submitUrl,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: `url=${encodeURIComponent(pageUrl)}&anyway=1`,
      onload(response) {
        // archive.today returns a "Refresh" header or redirects to the snapshot.
        const snapshotUrl = response.finalUrl || response.responseURL;

        const isSnapshot = snapshotUrl &&
          /archive\.(today|ph|is|fo|li)\/[a-zA-Z0-9]{4,}/.test(snapshotUrl) &&
          !snapshotUrl.includes("/submit");

        if (isSnapshot) {
          GM_openInTab(snapshotUrl, { active: true });
        } else {
          // Fallback: open the submit page directly in a new tab so the user
          // can watch the archiving progress and land on the snapshot.
          GM_openInTab(`${submitUrl}?url=${encodeURIComponent(pageUrl)}`, { active: true });
        }
        setTimeout(resetButton, 1500);
      },
      onerror() {
        // Last resort: just open the submit page in a new tab.
        GM_openInTab(`${ARCHIVE_HOST}/submit/?url=${encodeURIComponent(pageUrl)}`, { active: true });
        setTimeout(resetButton, 1500);
      },
    });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  injectStyles();
  createButton();
})();
