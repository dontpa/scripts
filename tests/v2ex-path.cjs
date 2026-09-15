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
 await page.route('**/*', r => r.fulfill({body:'<html><body></body></html>',contentType:'text/html'}));
 await page.goto('https://edge.v2ex.com/t/1');
 await page.addStyleTag({content:'.cell{padding:10px;border-bottom:1px solid #ccc}.fr{float:right}.avatar{width:48px;height:48px}body{font:14px sans-serif}' + css + '\nbody{margin:0} #test{width:min(800px,100%);margin:auto}'});
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

 // Exact ancestry is on-demand; no numeric rail UI or hidden path work at rest.
 assert.equal(await page.locator('.reply-path').count(),0);
 assert.equal(await page.locator('.reply-rail-target').count(),39);
 assert.deepEqual(await page.locator('.reply-rail-target').allTextContents(),Array(39).fill(''));
 await page.locator('#r_40 .reply-rail-target').press('Enter');
 assert.equal(await page.locator('.reply-path-caption').innerText(),'第 39 层对话');
 assert.equal(await page.locator('.reply-on-path').count(),40);
 await page.getByRole('button',{name:'展开中间的祖先楼层',exact:true}).click();
 assert.equal(await page.locator('.reply-path-all button').count(),36);
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'#2');
 await page.getByRole('button',{name:'定位第 20 楼',exact:true}).click();
 assert.equal(await page.locator('.reply-path-caption').innerText(),'第 19 层对话');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.reply-path').count(),0);
 assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('aria-label')),'查看第 20 楼的回复路径');
 await page.locator('#r_40 .reply-rail-target').click();
 await page.locator('[data-reply-id="20"] > .reply-branch-toggle').click();
 assert.equal(await page.locator('.reply-path').count(),0);
 assert.equal(await page.locator('#r_40').isVisible(),false);
 await page.locator('#v2-children-20 + .reply-collapsed-hint').press('Enter');
 await page.locator('#r_40 .reply-rail-target').click();
 await page.getByRole('button',{name:'定位第 1 楼',exact:true}).click();
 assert.equal(await page.locator('.reply-path-caption').innerText(),'第 0 层对话');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'r_1');
 await page.getByRole('button',{name:'关闭路径',exact:true}).click();
 assert.equal(await page.evaluate(()=>document.activeElement.id),'r_1');
 await page.evaluate(()=>{
   const more=[{n:41,p:38},{n:42,p:41},{n:43,p:2}].map(({n,p},i)=>{
    const cell=replies[0].element.cloneNode(true);cell.id='r_'+n;cell.querySelector('.no').textContent=n;
    cell.querySelector('.reply_content').textContent='#'+p+' another branch';
    return tree.parseReplyCell(cell,40+i);
   }); window.withForks=[...replies,...more];
   tree.renderTree(withForks,tree.buildLookupMaps(withForks),document.getElementById('test'),'forks');
 });
 assert.equal(await page.locator('#r_41 .reply-parent-link').innerText(),'另一个分支 · 回复 #38');
 assert.equal(await page.locator('#r_42 .reply-parent-link').innerText(),'回复 #41');
 const tones=await page.evaluate(()=>[39,40,41,42,43].map(n=>document.getElementById('r_'+n).parentElement._v2Tone));
 assert.equal(tones[0],tones[1]);assert.equal(tones[2],tones[3]);assert.notEqual(tones[0],tones[2]);assert.notEqual(tones[2],tones[4]);
 await page.locator('#r_41 .reply-rail-target').click();
 assert.equal(await page.locator('.reply-path-caption').innerText(),'第 38 层对话');
 await page.evaluate(()=>tree.renderTree(withForks,tree.buildLookupMaps(withForks),document.getElementById('test'),'forks'));
 assert.equal(await page.locator('.reply-path').count(),0);
 assert.equal(await page.locator('#r_41 .reply-path-trigger').count(),1);
 assert.equal(await page.locator('#r_41 .reply-rail-target').count(),1);
 await page.locator('#r_41 .reply-rail-target').click();
 assert.equal(await page.locator('.reply-path').count(),1);
 for(const width of [1280,768,390]){
   await page.setViewportSize({width,height:900});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   const widths=await page.evaluate(()=>[3,40].map(n=>document.querySelector('#r_'+n+' .reply_content').getBoundingClientRect().width));
   assert.equal(widths[0],widths[1]);
 }
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.evaluate(()=>{const box=document.getElementById('test');const night=document.createElement('div');night.id='Wrapper';night.className='Night';box.before(night);night.append(box);});
 assert.equal(await page.locator('#r_41').evaluate(c=>getComputedStyle(c,'::before').borderLeftColor),'rgb(138, 185, 175)');
 console.log('PASS on-demand ancestry, no rail numbers, expansion/jumps/Escape focus, root focus, collapse cleanup, rerender cleanup, local colors and fork labels, fixed width, night rail tokens');
 await browser.close();
})();
