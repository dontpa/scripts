// Optional V2EX_OFFICIAL_JS validates against the downloaded official combo.js helpers.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, webkit } = require('playwright');
const source = fs.readFileSync(path.join(__dirname, '../v2ex-tweaks.user.js'), 'utf8');
const nav = source.slice(source.indexOf('  const NavKeys ='), source.indexOf('  // 8) 功能F'));
const replies = source.slice(source.indexOf('  const Replies ='), source.indexOf('  // 6) 功能D'));
(async () => {
  const browser = await (process.env.V2EX_BROWSER === 'webkit' ? webkit : chromium).launch({headless: true,
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
  try {
    for (const mode of ['off', 'a', 'b', 'c', 'd', 'e', 'f']) {
      const page = await browser.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => r.fulfill({body: '<main id="Main"></main>', contentType: 'text/html'}));
      await page.goto('https://edge.v2ex.com/t/1?p=2');
      await page.evaluate(mode => {
        window.CONFIG = {nav: {scrollOffsetRatio: 0.22}, replies: {readKeyPrefix: 'test-'}};
        window.isTopicPage = () => true; window.log = () => {};
        window.savedFloor = 1;
        window.GM = {get: () => savedFloor, set: (_key, value) => { savedFloor = value; }};
        window.debounce = (fn, ms) => { let id; return () => {clearTimeout(id); id = setTimeout(fn, ms);}; };
        window.scrolls = []; window.scrollTo = o => scrolls.push(o);
        const style = document.createElement('style');
        style.textContent = '.cell{height:100px}.reply-tree-hidden{display:none}.reply-toggle{display:block;width:24px;height:24px}';
        document.head.append(style);
        const box = document.createElement('div'); box.className = `box reply-threads reply-threads-${mode}`;
        box.id = 'reply-box'; document.getElementById('Main').append(box);
        const make = (n, depth, folded = false) => {
          const cell = document.createElement('div'); cell.className = 'cell'; cell.id = `r_${n}`;
          cell.dataset.depth = depth;
          cell.innerHTML = `<div class="fr"><span class="no">${n}</span></div><strong><a href="/member/u">u</a></strong><div class="reply_content">body</div>`;
          if (folded) {
            cell.classList.add('reply-tree-folded');
            const button = document.createElement('button'); button.className = 'reply-toggle'; button.setAttribute('aria-expanded', 'false');
            cell.append(button);
          }
          box.append(cell); return cell;
        };
        make(1, 0, mode === 'd'); make(5, 1, mode === 'd'); make(6, 2); make(3, 1, mode === 'd'); make(7, 2); make(2, 0);
        if (mode === 'd') for (const n of [5,6,3,7]) document.getElementById(`r_${n}`).classList.add('reply-tree-hidden');
        if (mode === 'c') {
          const group = document.createElement('div'); group.className = 'reply-group';
          box.children[0].after(group); for (const n of [5,6,3,7]) group.append(document.getElementById(`r_${n}`));
        }
        if (mode === 'e') {
          const quote = document.createElement('details'); quote.className = 'reply-quote';
          quote.innerHTML = '<summary>更早上文</summary><div class="cell reply-new" id="r_999"><span class="no">999</span></div>';
          document.getElementById('r_5').append(quote);
        }
        if (mode === 'f') { const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.classList.add('reply-lines'); box.append(svg); }
        window.nativeClicks = [];
        box.addEventListener('click', e => {
          if (!e.target.matches('.reply-toggle')) return;
          nativeClicks.push(e.target.parentElement.id);
          // Use the actual official helper when supplied by the test runner.
          if (window.toggleReplyTree) return window.toggleReplyTree(e.target);
          const owner = e.target.parentElement, depth = +owner.dataset.depth;
          const open = e.target.getAttribute('aria-expanded') === 'false';
          e.target.setAttribute('aria-expanded', String(open));
          owner.classList.toggle('reply-tree-folded', !open);
          let stop = Infinity;
          for (let row = owner.nextElementSibling; row && +row.dataset.depth > depth; row = row.nextElementSibling) {
            if (!open) row.classList.add('reply-tree-hidden');
            else if (+row.dataset.depth <= stop) {
              row.classList.remove('reply-tree-hidden'); stop = Infinity;
              if (row.querySelector('.reply-toggle[aria-expanded="false"]')) stop = +row.dataset.depth;
            }
          }
        });
        window.order = [...box.querySelectorAll('.cell')].map(e => e.id);
        window.key = (key, props = {}) => { const e = new KeyboardEvent('keydown', {key, cancelable: true, ...props}); document.dispatchEvent(e); return e.defaultPrevented; };
      }, mode);
      if (process.env.V2EX_OFFICIAL_JS) {
        const official = fs.readFileSync(process.env.V2EX_OFFICIAL_JS, 'utf8');
        const start = official.indexOf('function toggleReplyTree(');
        const end = official.indexOf('// Unfold whatever hides', start);
        assert.ok(start > 0 && end > start);
        await page.evaluate('(() => {' + official.slice(start, end) + '\nwindow.toggleReplyTree = toggleReplyTree;})()');
      }
      await page.evaluate(replies + '\nReplies.boot();');
      await page.evaluate(nav + '\nNavKeys.boot();');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => key('j')), true);
      assert.equal(await page.locator('.reply-nav-active').getAttribute('id'), 'r_5', mode);
      assert.equal(await page.evaluate(() => key('j')), true);
      assert.equal(await page.locator('.reply-nav-active').getAttribute('id'), 'r_6', mode);
      if (mode === 'd') {
        assert.deepEqual(await page.evaluate(() => nativeClicks), ['r_1', 'r_5']);
        assert.equal(await page.locator('#r_3 > .reply-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#r_7').isVisible(), false, 'unrelated branch remains collapsed');
        await page.locator('#r_1 > .reply-toggle').click();
        await page.evaluate(() => key('k'));
        assert.equal(await page.locator('#r_5').isVisible(), true, 'repeated navigation reopens refolded ancestor');
      }
      if (mode === 'e') assert.equal(await page.locator('details').getAttribute('open'), null);
      assert.equal(await page.evaluate(() => key('j', {isComposing: true})), false);
      assert.equal(await page.evaluate(() => key('j', {shiftKey: true})), false);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('#reply-box .cell')].map(e => e.id)), await page.evaluate(() => order));
      // Native Ajax list replacement: new identities and no stale highlights/cached nodes.
      await page.evaluate(() => {
        const box = document.getElementById('reply-box');
        box.innerHTML = '<div class="cell" id="r_20"><span class="no">20</span><strong><a>u</a></strong><div class="reply_content">fresh</div></div><div class="cell" id="r_21" style="display:none"><span class="no">21</span><strong><a>u</a></strong><div class="reply_content">hidden</div></div>';
      });
      await page.waitForTimeout(350);
      assert.deepEqual(await page.evaluate(() => savedFloor), {version: 2, floor: 3, ranges: [[5,7],[20,21]]}, 'Ajax replacement must preserve existing seen ranges');
      assert.equal(await page.evaluate(() => key('j')), true);
      assert.equal(await page.locator('.reply-nav-active').getAttribute('id'), 'r_20');
      const scrollCount = await page.evaluate(() => scrolls.length);
      assert.equal(await page.evaluate(() => key('j')), false);
      assert.equal(await page.evaluate(() => scrolls.length), scrollCount, 'hidden reply/end does not scroll to top');
      assert.equal(await page.locator('#r_21').isVisible(), false);
      assert.match(await page.locator('#v2ex-new-count-bar').innerText(), /本页/);
      assert.deepEqual(errors, []);
      await page.close();
    }
    const page = await browser.newPage();
    await page.route('**/*', r => r.fulfill({body: '<main id="Main"><div class="box" id="replies"></div></main>', contentType: 'text/html'}));
    await page.goto('https://edge.v2ex.com/t/2?p=2');
    await page.evaluate(() => {
      window.CONFIG = {replies: {readKeyPrefix: 'test-'}};
      window.isTopicPage = () => true; window.log = () => {};
      window.saved = null; window.GM = {get: () => saved, set: (_key, value) => saved = value};
      window.debounce = (fn, ms) => { let id; return () => {clearTimeout(id); id = setTimeout(fn, ms);}; };
      window.addReply = floor => {
        const cell = document.createElement('div'); cell.className = 'cell'; cell.id = `r_${floor}`;
        cell.innerHTML = `<div class="fr"><span class="no">${floor}</span></div><strong><a>u</a></strong><div class="reply_content">body</div>`;
        document.getElementById('replies').append(cell);
      };
      addReply(51);
    });
    await page.evaluate(replies + '\nReplies.boot();');
    assert.equal(await page.locator('.reply-new').count(), 0);
    await page.evaluate(() => addReply(52));
    await page.waitForTimeout(350);
    assert.deepEqual(await page.locator('.reply-new').evaluateAll(els => els.map(el => el.id)), ['r_52'], 'first visit transitions to tracking newly added replies');
    await page.evaluate(() => addReply(53));
    await page.waitForTimeout(350);
    assert.deepEqual(await page.locator('.reply-new').evaluateAll(els => els.map(el => el.id)), ['r_52','r_53'], 'new markers survive subsequent updates');
    assert.deepEqual(await page.evaluate(() => saved), {version: 2, floor: 0, ranges: [[51,53]]});
    await page.close();
    console.log('PASS all seven native styles, visual order, nested collapse, preserved branches/quotes, hidden replies, IME, Ajax replacement and page boundaries');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
