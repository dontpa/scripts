const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const source = fs.readFileSync(path.join(__dirname, '../v2ex-tweaks.user.js'), 'utf8');
  assert.doesNotMatch(source, /ThreadTree|reply-wrapper|reply-branch-toggle|initReplyFloorReference|renderReplies|fetchReplyPage|#bottom-pagination/);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({body: '<body></body>', contentType: 'text/html'}));
    await page.goto('https://edge.v2ex.com/t/1?p=2');
    const module = source.slice(source.indexOf('  const Replies ='), source.indexOf('  // 6) 功能D'));
    const styles = [];
    for (const match of source.matchAll(/addStyle\(`([\s\S]*?)`\);/g)) styles.push(match[1]);
    await page.addStyleTag({content: styles.join('\n')});
    for (const mode of ['reply-threads-d', 'reply-threads-c', '']) {
      await page.setContent(`<div id="Main"><div class="box reply-threads ${mode}" id="replies"><div class="cell" style="text-align: center"><a class="page_normal" href="?p=1">1</a><span class="page_current">2</span><input class="page_input"></div><div id="native-group"></div><div id="bottom-pagination"><a name="last_page" href="?p=3">3</a></div></div></div>`);
      await page.addStyleTag({content: styles.join('\n')});
      await page.evaluate(() => {
        window.CONFIG = {replies: {readKeyPrefix: 'test-read-'}};
        window.log = () => {}; window.isTopicPage = () => true;
        window.debounce = (fn, ms) => { let timer; return () => { clearTimeout(timer); timer = setTimeout(fn, ms); }; };
        window.saved = [];
        window.GM = {get: () => 49, set: (...args) => saved.push(args)};
        window.fetch = () => { throw new Error('Replies must not fetch other pages'); };
        const group = document.getElementById('native-group');
        window.cells = [51, 55, 52, 54, 53].map((n, i) => {
          const cell = document.createElement('div');
          cell.className = 'cell'; cell.id = `r_${n}`;
          cell.dataset.depth = i % 2; cell.style.setProperty('--depth', i % 2);
          cell.innerHTML = `<div class="fr"><a href="#reply_content" onclick="this.dataset.native='yes'">回复</a><span class="no">${n}</span></div><strong><a href="/member/user">user</a></strong><div class="reply_content">hello</div>`;
          group.append(cell); return cell;
        });
        const toggle = document.createElement('button'); toggle.id = 'native-toggle';
        toggle.textContent = '折叠'; toggle.onclick = () => cells[1].hidden = !cells[1].hidden;
        group.prepend(toggle);
        window.original = group.innerHTML;
        window.changes = [];
        new MutationObserver(records => changes.push(...records.filter(r => r.type === 'childList')))
          .observe(document.getElementById('replies'), {childList: true, subtree: true});
        window.clicks = 0; cells[0].addEventListener('click', () => clicks++);
      });
      await page.evaluate(module + '\nReplies.boot();');
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => {
        const group = document.getElementById('native-group');
        const allUnread = cells.every(cell => cell.classList.contains('reply-new'));
        cells.forEach(cell => { cell.classList.remove('reply-new'); cell.querySelector('.no').removeAttribute('title'); });
        const unchanged = group.innerHTML === original;
        cells[0].querySelector('a').click();
        document.getElementById('native-toggle').click();
        return {unchanged, allUnread, order: cells.map(c => c.querySelector('.no').textContent),
          actual: [...group.querySelectorAll('.cell')].map(c => c.querySelector('.no').textContent),
          mutations: changes.length, clicks, native: cells[0].querySelector('a').dataset.native,
          collapsed: cells[1].hidden, saved,
          pagination: [...document.querySelectorAll('.page_normal,.page_current,.page_input,#bottom-pagination,a[name="last_page"]')].every(e => e.getClientRects().length > 0)};
      });
      assert.equal(result.unchanged, true, mode);
      assert.equal(result.allUnread, true);
      assert.deepEqual(result.actual, ['51','55','52','54','53']);
      assert.equal(result.mutations, 0);
      assert.equal(result.clicks, 1);
      assert.equal(result.native, 'yes');
      assert.equal(result.collapsed, true);
      assert.equal(result.pagination, true);
      assert.deepEqual(result.saved, [['test-read-1', {version: 2, floor: 49, ranges: [[51,55]]}]], 'remember this page without marking the missing floor read');
    }
    console.log('PASS native threaded/flat order, nested containers, collapse and reply controls, pagination, no page fetches, and safe unread progress');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
