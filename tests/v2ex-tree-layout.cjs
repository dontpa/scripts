// Run with Playwright available on NODE_PATH; optionally set PLAYWRIGHT_EXECUTABLE_PATH.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
 const page = await browser.newPage();
 const source = fs.readFileSync(require('node:path').join(__dirname,'../v2ex-tweaks.user.js'),'utf8');
 const css = source.split('if (isTopicPage()) addStyle(`')[1].split('`);')[0];
 const module = source.slice(source.indexOf('  const ThreadTree = (() => {'), source.indexOf('  // 6) 功能D'));
 await page.route('**/*', r => r.fulfill({body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',contentType:'text/html'}));
 await page.goto('https://edge.v2ex.com/t/1');
 await page.addStyleTag({content:'.cell{padding:10px;border-bottom:1px solid #ccc}.fr{float:right}.avatar{width:48px;height:48px}body{font:14px -apple-system,sans-serif}td{vertical-align:top}a{color:#66727d;text-decoration:none}.ago{margin-left:8px}' + css + '\nbody{margin:0} #test{width:min(800px,100%);margin:auto}'});
 await page.evaluate(module.replace('return { boot, revealAncestors };','return { renderTree, parseReplyCell, buildLookupMaps, revealAncestors };') + '\nwindow.tree=ThreadTree;', );
 await page.evaluate(() => {
 window.CONFIG={threadTree:{collapseKeyPrefix:'test-collapse-'}}; window.log=console.log;
 const box=document.createElement('div');box.id='test';box.className='box';document.body.append(box);
 const replies=Array.from({length:40},(_,i)=>{
 const cell=document.createElement('div');cell.id='r_'+(i+1);cell.className='cell';
 cell.innerHTML=`<table width="100%" cellspacing="0"><tbody><tr><td width="48"><img class="avatar" alt="头像"></td><td width="10"></td><td><div class="fr"><span class="no">${i+1}</span></div><strong><a href="/member/user">user</a></strong><span class="ago">5 小时 58 分钟前</span><div class="sep5"></div><div class="reply_content">${i?'#'+i+' ':''}这是一条用于检查深层回复可读性的长回复。无论对话有多少层，正文都应该保留足够的阅读宽度。</div></td></tr></tbody></table>`;
 return tree.parseReplyCell(cell,i);
 }); window.replies=replies;tree.renderTree(replies,tree.buildLookupMaps(replies),box,'fixture');
 });
 let failed=false;
 for(const width of [1280,768,390]) {
 await page.setViewportSize({width,height:900});
 const result=await page.evaluate(()=>({body:document.querySelector('#r_40 .reply_content').getBoundingClientRect().width, overflow:document.documentElement.scrollWidth>innerWidth}));
 console.log(width,result);if(result.body < (width<400?200:400)||result.overflow)failed=true;
 }
 await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').click();
 assert.equal(await page.locator('#r_40').isVisible(),false);
 assert.equal(await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').getAttribute('aria-expanded'),'false');
 await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').focus();
 await page.keyboard.press('Enter');
 assert.equal(await page.locator('#r_40').isVisible(),true);
 await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').click();
 await page.evaluate(()=>tree.revealAncestors(document.getElementById('r_40')));
 assert.equal(await page.locator('#r_40').isVisible(),true);
 assert.equal(await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').getAttribute('aria-expanded'),'true');
 await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').click();
 await page.evaluate(()=>tree.renderTree(replies,tree.buildLookupMaps(replies),document.getElementById('test'),'fixture'));
 assert.equal(await page.locator('#r_40').isVisible(),false);
 assert.equal(await page.locator('.reply-context').count(),0);
 assert.equal(await page.locator('.reply-parent-link').count(),39);
 assert.equal((await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').textContent()).trim(),'+');
 await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').click();
 await page.locator('#r_40 .reply-parent-link').click();
 assert.equal(await page.evaluate(()=>location.hash),'#r_39');
 await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').click();
 const hint = page.locator('#r_20 .reply-collapsed-hint');
 assert.equal(await hint.innerText(),'展开 20 条回复');
 await hint.press('Enter');
 assert.equal(await page.locator('#r_40').isVisible(),true);
 assert.equal(await page.evaluate(()=>document.activeElement.closest('.reply-wrapper')?.dataset.replyId),'20');
 await page.locator('#r_20 .reply_content').click();
 assert.equal(await page.locator('#r_40').isVisible(),true);
 await page.evaluate(()=>{
 const cell=replies[0].element.cloneNode(true);
 cell.id='r_41';cell.querySelector('.no').textContent='41';
 cell.querySelector('.reply_content').textContent='独立回复，没有子回复';
 const leaf=tree.parseReplyCell(cell,40);
 const rows=[...replies,leaf];
 tree.renderTree(rows,tree.buildLookupMaps(rows),document.getElementById('test'),'alignment');
 });
 const alignment=await page.evaluate(()=>{
 const root=document.getElementById('r_1'),leaf=document.getElementById('r_41');
 return {
  rootPadding:getComputedStyle(root).paddingLeft,
  leafPadding:getComputedStyle(leaf).paddingLeft,
  rootLeft:root.querySelector('table').getBoundingClientRect().left,
  leafLeft:leaf.querySelector('table').getBoundingClientRect().left,
  leafControls:leaf.parentElement.querySelectorAll('.reply-branch-toggle').length,
  controlInCell:root.querySelectorAll('.reply-branch-toggle').length,
  depth3:document.getElementById('r_3').getBoundingClientRect().left,
  depth40:document.getElementById('r_40').getBoundingClientRect().left
 };
 });
 assert.equal(alignment.rootPadding,'10px');assert.equal(alignment.leafPadding,'10px');
 assert.equal(alignment.rootLeft,alignment.leafLeft);
 assert.equal(alignment.leafControls,0);assert.equal(alignment.controlInCell,0);
 assert.equal(alignment.depth3,alignment.depth40);
 await page.locator('.reply-wrapper[data-reply-id="1"] .reply-branch-toggle').click();
 assert.equal(await page.locator('#r_1').isVisible(),true);
 assert.equal(await page.locator('#r_40').isVisible(),false);
 assert.equal(await page.locator('#r_41').isVisible(),true);
 console.log('PASS flat body alignment and isolated branch collapse');
 console.log('PASS collapse, keyboard/hint expansion, ancestor reveal, persisted rerender, parent link, body click');
 // A comb-shaped tree forces active forks beyond the four visible lanes.
 await page.evaluate(()=>{
 sessionStorage.clear();
 const parents=[null,1,2,3,4,5,6,6,5,4,3,2,1];
 const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="5" fill="#dde6e9"/><circle cx="24" cy="18" r="8" fill="#7b919a"/><path d="M8 44a16 16 0 0 1 32 0" fill="#7b919a"/></svg>');
 window.forkReplies=parents.map((parent,i)=>{
 const cell=replies[0].element.cloneNode(true); cell.id='r_'+(i+1);
 cell.querySelector('.no').textContent=i+1; cell.querySelector('.avatar').src=avatar;
 cell.querySelector('.reply_content').textContent=(parent?'#'+parent+' ':'')+'分支回复，正文始终对齐。';
 return tree.parseReplyCell(cell,i);
 });
 tree.renderTree(forkReplies,tree.buildLookupMaps(forkReplies),document.getElementById('test'),'forks');
 });
 assert.deepEqual(await page.locator('#test > .reply-row').evaluateAll(rows=>rows.map(r=>Number(r.dataset.lane))),[0,1,2,3,4,5,6,5,4,3,2,1,0]);
 assert.equal(await page.locator('.reply-row .reply-row').count(),0);
 assert.equal(await page.locator('#r_7 .reply-overflow').count(),1);
 await page.locator('#r_7 .reply-overflow').click();
 assert.equal(await page.locator('#r_7 .reply-ancestors a').count(),6);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#r_7 .reply-ancestors').isVisible(),false);
 await page.locator('#r_13').hover();
 assert.equal(await page.locator('.reply-graph-node.is-path').count(),2);
 assert.equal(await page.locator('.reply-row[data-reply-id="7"] .reply-graph-through.is-path').count(),1);
 await page.locator('.reply-row[data-reply-id="2"] .reply-branch-toggle').click();
 assert.equal(await page.locator('#r_12').isVisible(),false);
 assert.equal(await page.locator('#r_13').isVisible(),true);
 await page.evaluate(()=>tree.revealAncestors(document.getElementById('r_7')));
 assert.equal(await page.locator('#r_7').isVisible(),true);
 for(const width of [1280,390]) {
 await page.setViewportSize({width,height:900});
 assert.equal(await page.locator('.reply-row > .cell').evaluateAll(cells=>new Set(cells.map(c=>c.getBoundingClientRect().left)).size),1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:'/tmp/v2ex-graph-'+width+'.png',fullPage:true});
 }
 console.log('PASS active fork reuse, bounded lanes, overflow ancestry, path highlight, flat collapse, mobile width');
 await browser.close();process.exitCode=failed?1:0;
})();
