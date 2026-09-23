// Run with Playwright available on NODE_PATH; optionally set PLAYWRIGHT_EXECUTABLE_PATH.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
 const page = await browser.newPage();
 const source = fs.readFileSync(process.env.V2EX_BASELINE_FILE || require('node:path').join(__dirname,'../v2ex-tweaks.user.js'),'utf8');
 const css = source.split('if (isTopicPage()) addStyle(`')[1].split('`);')[0];
 const module = source.slice(source.indexOf('  const ThreadTree = (() => {'), source.indexOf('  // 6) 功能D'));
 await page.route('**/*', r => r.fulfill({body:'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',contentType:'text/html'}));
 await page.goto('https://edge.v2ex.com/t/1');
 await page.addStyleTag({content:'.cell{padding:10px;border-bottom:1px solid #ccc}.fr{float:right}.no{display:inline-block;padding:1px 3px;border-radius:3px;color:#89919c;background:#f2f3f5;font-size:12px;font-weight:400}#Wrapper.Night .no{color:#abb1ba;background:#353941}.avatar{width:48px;height:48px}body{font:14px -apple-system,sans-serif}td{vertical-align:top}a{color:#66727d;text-decoration:none}.ago{margin-left:8px}' + css + '\nbody{margin:0} #test{width:min(800px,100%);margin:auto}'});
 await page.evaluate(module.replace('return { boot, revealAncestors };','return { renderTree, parseReplyCell, buildLookupMaps, revealAncestors, initHoverPreview, extractFloorReferences };') + '\nwindow.tree=ThreadTree;', );
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
 await page.waitForTimeout(80);
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
 assert.equal(await page.locator('.v2-reply-head .reply-parent-link').count(),39);
 assert.equal((await page.locator('[data-reply-id="20"].reply-wrapper .reply-branch-toggle').textContent()).trim(),'');
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
 assert.equal(alignment.leafControls,0);assert.equal(alignment.controlInCell,1);
 assert.equal(alignment.depth40-alignment.depth3,24);
 await page.locator('.reply-wrapper[data-reply-id="1"] .reply-branch-toggle').click();
 assert.equal(await page.locator('#r_1').isVisible(),true);
 assert.equal(await page.locator('#r_40').isVisible(),false);
 assert.equal(await page.locator('#r_41').isVisible(),true);
 console.log('PASS flat body alignment and isolated branch collapse');
 console.log('PASS collapse, keyboard/hint expansion, ancestor reveal, persisted rerender, parent link, body click');
 await page.evaluate(()=>tree.revealAncestors(document.getElementById('r_40')));
 await page.waitForTimeout(80);
 assert.equal(await page.locator('.reply-row .reply-row').count(),0);
 assert.equal(await page.locator('.reply-connectors path').count(),3);
 assert.equal(await page.locator('.reply-window-context').count(),0);
 const xs=await page.locator('.reply-row > .cell').evaluateAll(cells=>cells.slice(0,8).map(c=>c.getBoundingClientRect().left));
 assert.ok(xs[0] < xs[1] && xs[1] < xs[2] && xs[2] < xs[3]);
 assert.ok(xs.slice(3).every(x=>x===xs[3]));
 for (const width of [1280,390]) {
 await page.setViewportSize({width,height:900});
 await page.waitForTimeout(80);
 await page.evaluate(()=>{
 const avatar='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="5" fill="#dde6e9"/><circle cx="24" cy="18" r="8" fill="#7b919a"/><path d="M8 44a16 16 0 0 1 32 0" fill="#7b919a"/></svg>');
 document.querySelectorAll('.avatar').forEach(a=>a.src=avatar);
 });
 await page.waitForTimeout(80);
 await page.screenshot({animations:'disabled',path:'/tmp/v2ex-avatar-'+width+'.png'});
 }
 await page.evaluate(()=>{
 const parents=[null,1,2,3,4,5,3,2,1];
 window.branchReplies=parents.map((parent,i)=>{
 const cell=replies[0].element.cloneNode(true); cell.id='r_'+(i+1);
 cell.querySelector('.no').textContent=i+1;
 cell.querySelector('.reply_content').textContent=(parent?'#'+parent+' ':'')+'测试分叉后的继续阅读。';
 return tree.parseReplyCell(cell,i);
 });
 tree.renderTree(branchReplies,tree.buildLookupMaps(branchReplies),document.getElementById('test'),'branches');
 });
 await page.waitForTimeout(80);
 assert.equal(await page.locator('#r_1').evaluate(el=>el.getBoundingClientRect().left),0);
 assert.equal(await page.locator('.reply-window-context').count(),0);
 assert.deepEqual(await page.locator('.reply-row').evaluateAll(rows=>rows.map(row=>row.style.getPropertyValue('--reply-level'))),['0','1','2','3','3','3','3','2','1']);
 await page.evaluate(()=>tree.initHoverPreview(branchReplies,tree.buildLookupMaps(branchReplies)));
 await page.locator('#r_6 .reply-parent-link').hover();
 assert.equal(await page.locator('#r_5').evaluate(el=>el.classList.contains('reply-parent-highlight')),true);
 assert.equal(await page.locator('#v2ex-ref-preview.visible').count(),0);
 await page.locator('#r_6 .reply-parent-link').focus();
 assert.equal(await page.locator('#v2ex-ref-preview.visible').count(),0);
 await page.locator('#r_7 .reply-parent-link').hover();
 assert.equal(await page.locator('#v2ex-ref-preview.visible .rp-floor').innerText(),'#3');
 await page.locator('#r_6 .reply-parent-link').hover();
 assert.equal(await page.locator('#v2ex-ref-preview.visible').count(),0);
 await page.evaluate(()=>document.querySelector('#r_5 .reply_content').style.minHeight='1000px');
 await page.locator('#r_6 .reply-parent-link').focus();
 await page.locator('#r_6 .reply-parent-link').hover();
 assert.equal(await page.locator('#v2ex-ref-preview.visible .rp-floor').innerText(),'#5');
 await page.evaluate(()=>document.querySelector('#r_5 .reply_content').style.minHeight='');
 await page.locator('#r_1 .reply_content').click();
 assert.equal(await page.locator('.reply-parent-highlight').count(),0);
 await page.locator('#r_3 .reply-branch-toggle').click();
 assert.equal(await page.locator('#r_7').isVisible(),false);
 assert.equal(await page.locator('#r_8').isVisible(),true);
 await page.evaluate(()=>tree.revealAncestors(document.getElementById('r_6')));
 assert.equal(await page.locator('#r_6').isVisible(),true);
 await page.waitForTimeout(80);
 const before = await page.locator('.reply-connectors').innerHTML();
 await page.evaluate(()=>document.querySelector('#r_1 .reply_content').style.minHeight='200px');
 await page.waitForTimeout(80);
 assert.notEqual(await page.locator('.reply-connectors').innerHTML(),before);
 // Recompute from container width, not reply count or viewport alone.
 await page.setViewportSize({width:1280,height:900});
 await page.waitForTimeout(80);
 assert.equal(await page.locator('#test').getAttribute('data-max-visual-depth'),'8');
 await page.evaluate(()=>document.getElementById('test').style.width='650px');
 await page.waitForTimeout(80);
 const narrowCap=Number(await page.locator('#test').getAttribute('data-max-visual-depth'));
 assert.ok(narrowCap>=4 && narrowCap<8);
 assert.ok(await page.locator('#r_6 .reply_content').evaluate(el=>el.getBoundingClientRect().width)>=400);
 await page.evaluate(()=>document.getElementById('test').style.width='');
 await page.setViewportSize({width:320,height:900});
 await page.waitForTimeout(80);
 assert.equal(await page.locator('#test').getAttribute('data-max-visual-depth'),'0');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.ok(await page.locator('#r_6 .reply_content').evaluate(el=>el.getBoundingClientRect().width)>=240);
 console.log('PASS adaptive cap: wide container 8 levels, narrow container fewer, small mobile preserves text width');
 await page.evaluate(()=>{
 document.querySelector('#r_6 .ago').textContent='8 天前 via Android';
 document.querySelector('#r_6 .rh-id a').textContent='averylongmembername';
 const actions=document.querySelector('#r_6 .fr');
 const reply=document.createElement('a');reply.textContent='↩';reply.href='#reply';actions.prepend(reply);
 });
 for (const width of [390,768,1280]) {
 await page.setViewportSize({width,height:900});await page.waitForTimeout(80);
 const header=await page.locator('#r_6 .v2-reply-head').evaluate(el=>{
 const box=el.getBoundingClientRect(),actions=el.querySelector('.fr').getBoundingClientRect();
 return {dy:actions.top-box.top,right:Math.abs(actions.right-box.right),overlap:el.querySelector('.rh-details').getBoundingClientRect().right>actions.left};
 });
 assert.ok(header.dy<2);assert.ok(header.right<2);assert.equal(header.overlap,false);
 assert.equal(await page.locator('.v2-reply-head .reply-branch-toggle').count(),0);
 await page.locator('#r_6').scrollIntoViewIfNeeded();
 await page.screenshot({animations:'disabled',path:'/tmp/v2ex-header-'+width+'.png'});
 }
 console.log('PASS fixed upper-right floor actions, wrapping metadata, avatar collapse control');
 if (!process.env.V2EX_BASELINE_FILE) {
 const updates=await page.evaluate(async()=>{
 const box=document.getElementById('test'), svg=box.querySelector('.reply-connectors');
 let mutations=0;
 const observer=new MutationObserver(records=>{mutations+=records.length;});
 observer.observe(svg,{childList:true,subtree:true,attributes:true});
 for(let i=0;i<5;i++) {
  box._v2CollapseState.scheduleLines();
  await new Promise(resolve=>requestAnimationFrame(resolve));
 }
 observer.disconnect();
 return mutations;
 });
 assert.equal(updates,0,'unchanged geometry must not replace SVG nodes');
 const noOp=await page.evaluate(()=>{
 const state=document.getElementById('test')._v2CollapseState;
 let redraws=0;const original=state.scheduleLines;
 state.scheduleLines=()=>redraws++;
 for(let i=0;i<20;i++) tree.revealAncestors(document.getElementById('r_6'));
 state.scheduleLines=original;
 return redraws;
 });
 assert.equal(noOp,0,'revealing visible ancestors should not request full redraw');
 const references=await page.evaluate(()=>{
 const root=document.createElement('div');root.append('#1');let node=root;
 for(let i=0;i<2000;i++){const child=document.createElement('span');node.append(child);node=child;}
 node.append('#2');const code=document.createElement('code');code.textContent='#999';node.append(code);
 root.append('#3');return tree.extractFloorReferences(root);
 });
 assert.deepEqual(references,['1','2','3']);
 console.log('PASS unchanged SVG reuse, no-op ancestor reveal, deep reference scan ordering/exclusions');
 }
 console.log('PASS parent hover/focus preview, sibling isolation and dynamic connector measurement');
 console.log('PASS capped depth, no reset separators, shallow avatar connectors');
 await page.evaluate(() => {
  const box = document.getElementById('test');
  const wrapper = document.createElement('div'); wrapper.id = 'Wrapper';
  box.before(wrapper); wrapper.append(box);
  const native = document.createElement('div');
  native.innerHTML = '<div class="fr"><span class="no">8</span></div>';
  native.id = 'native-floor-reference';
  wrapper.append(native);
  document.getElementById('r_7').classList.add('reply-new');
 });
 for (const night of [false, true]) {
  await page.locator('#Wrapper').evaluate((el, enabled) => el.classList.toggle('Night', enabled), night);
  const result = await page.evaluate(() => {
   const unreadCell = document.getElementById('r_7');
   const unread = unreadCell.querySelector('.no');
   const snapshot = el => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
     display: style.display, fontSize: style.fontSize, fontWeight: style.fontWeight,
     lineHeight: style.lineHeight, padding: style.padding, border: style.border,
     borderWidth: style.borderWidth, borderStyle: style.borderStyle,
     borderRadius: style.borderRadius, color: style.color,
     background: style.backgroundColor, width: rect.width, height: rect.height,
    };
   };
   unreadCell.classList.remove('reply-new');
   const before = snapshot(unread);
   unreadCell.classList.add('reply-new');
   return {
    native: snapshot(document.querySelector('#native-floor-reference .no')),
    ordinary: snapshot(document.querySelector('#r_8 .no')),
    before, after: snapshot(unread),
   };
  });
  const { display: ordinaryDisplay, ...ordinaryAppearance } = result.ordinary;
  const { display: nativeDisplay, ...nativeAppearance } = result.native;
  assert.deepEqual(ordinaryAppearance, nativeAppearance, 'ordinary floor must keep native site styling');
  assert.notEqual(result.after.background, result.before.background);
  assert.notEqual(result.after.color, result.before.color);
  for (const key of ['display', 'fontSize', 'fontWeight', 'lineHeight', 'padding', 'borderWidth', 'borderStyle', 'width', 'height']) {
   assert.equal(result.after[key], result.before[key], `unread floor must preserve native ${key}`);
  }
  await page.locator('#r_8').hover();
  const hovered = await page.locator('#r_8 .no').evaluate(el => ({ color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor }));
  assert.deepEqual(hovered, { color: result.native.color, background: result.native.background });
  await page.locator('#r_7').scrollIntoViewIfNeeded();
  await page.screenshot({ animations: 'disabled', path: `/tmp/v2ex-unread-${night ? 'night' : 'light'}.png` });
 }
 console.log('PASS native ordinary floor styling and layout-neutral unread highlight in light/night themes');
 await browser.close();process.exitCode=failed?1:0;
})();
