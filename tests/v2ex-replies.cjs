const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../v2ex-tweaks.user.js'), 'utf8');
  assert.doesNotMatch(source, /ThreadTree|reply-tree|reply-branch-toggle|initReplyFloorReference/);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.setContent('<div class="box" id="replies"></div>');
    const module = source.slice(source.indexOf('  const Replies ='), source.indexOf('  // 6) 功能D'))
      .replace('return { boot };', 'return { renderReplies, parseReplyCell, normalizeReplies };');
    await page.evaluate(module + '\nwindow.repliesModule = Replies;');
    const result = await page.evaluate(() => {
      const box = document.getElementById('replies');
      const cells = [3, 1, 2].map(n => {
        const cell = document.createElement('div');
        cell.className = 'cell'; cell.id = `r_${n}`;
        cell.innerHTML = `<div class="fr"><a href="#reply_content" onclick="this.dataset.native='yes'">回复</a><span class="no">${n}</span></div><strong><a href="/member/user">user</a></strong><span class="ago">1h</span><div class="reply_content">@user #1 reply</div>`;
        return cell;
      });
      const before = cells.map(cell => cell.outerHTML);
      let clicks = 0, updates = 0;
      cells[0].addEventListener('click', () => clicks++);
      document.addEventListener('v2ex:replies-updated', () => updates++);
      const replies = repliesModule.normalizeReplies(cells.map(repliesModule.parseReplyCell));
      repliesModule.renderReplies(replies, box);
      repliesModule.renderReplies(replies, box);
      const unchanged = cells.every((cell, i) => cell.outerHTML === before[i]);
      cells[0].querySelector('a').click();
      return { order: [...box.children].map(cell => cell.id), unchanged, clicks, updates,
        native: cells[0].querySelector('a').dataset.native, wrappers: box.querySelectorAll('.reply-wrapper,svg,button').length };
    });
    assert.deepEqual(result, { order: ['r_1', 'r_2', 'r_3'], unchanged: true, clicks: 1, updates: 2, native: 'yes', wrappers: 0 });
    console.log('PASS flat reply order, native markup/actions, node reuse and navigation updates');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
