const fs = require('node:fs');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const source = fs.readFileSync(require('node:path').join(__dirname, '../v2ex-tweaks.user.js'), 'utf8');
(async () => {
 const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
 try {
  const page = await browser.newPage({viewport:{width:1000,height:650}});
  await page.setContent(`<div id="Wrapper"><div class="box"><div class="cell" id="r_36"><div class="flex-one-row"><strong>Parent</strong><span class="no">36</span></div><p>Parent reply</p><div class="reply-group"><div class="cell reply-group-item" id="r_49"><div class="flex-one-row"><strong>New reply</strong><span class="no">49</span></div><p>Reply inside native group</p></div><div class="cell reply-group-item" id="r_50"><div class="flex-one-row"><strong>Read reply</strong><span class="no">50</span></div><p>Another reply in the same group</p></div></div></div></div></div>`);
  await page.addStyleTag({content: `body{font:16px system-ui;background:#fff;margin:30px}.box{border:1px solid #ddd}.cell{padding:10px}.flex-one-row{display:flex;justify-content:space-between}.no{border-radius:12px;background:#eee;color:#ccc;padding:1px 6px}.reply-group{margin-top:10px;padding:0 10px;background:#f8f8f8;border-radius:6px}.reply-group>.reply-group-item{padding:8px 0;border-bottom:0}.reply-group>.reply-group-item+.reply-group-item{border-top:1px solid #ddd}`});
  for(const m of source.matchAll(/addStyle\(`([\s\S]*?)`\);/g)) await page.addStyleTag({content:m[1]});
  await page.evaluate(()=>{window.CONFIG={nav:{scrollOffsetRatio:0.22}};window.isTopicPage=()=>true;window.scrollTo=()=>{};});
  const replies = source.slice(source.indexOf('  const Replies ='), source.indexOf('  // 6) 功能D')).replace('return { boot };', 'return { markUnread };');
  await page.evaluate(replies+'\nwindow.replyApi=Replies;');
  const nav=source.slice(source.indexOf('  const NavKeys ='),source.indexOf('  // 8) 功能F'));
  await page.evaluate(nav+'\nNavKeys.boot();');
  await page.evaluate(()=>{
   window.mark = floors => replyApi.markUnread({firstVisit:false,lastReadFloor:0,readRanges:[]},floors.map(n=>({floorNum:n,element:document.getElementById('r_'+n),floorEl:document.getElementById('r_'+n).querySelector('.no')})));
   mark([49]);
  });
  for(const night of [false,true]){
   await page.evaluate(night=>document.getElementById('Wrapper').classList.toggle('Night',night),night);
   assert.equal(await page.locator('#r_49 .no').evaluate(el=>getComputedStyle(el).color),night?'rgb(180, 200, 255)':'rgb(54, 95, 190)');
   assert.equal(await page.locator('#r_50 .no').evaluate(el=>getComputedStyle(el).color),'rgb(204, 204, 204)');
  }
  await page.evaluate(()=>{document.getElementById('Wrapper').classList.remove('Night');document.dispatchEvent(new KeyboardEvent('keydown',{key:'j'}));});
  const bounds=()=>page.evaluate(()=>{
   const el=document.querySelector('.reply-nav-active'), group=el.parentElement;
   const a=el.getBoundingClientRect(), b=group.getBoundingClientRect(), style=getComputedStyle(el,'::after');
   return {left:a.left+parseFloat(style.left)-b.left,right:a.right-parseFloat(style.right)-b.right,height:a.height,groupHeight:b.height,radius:style.borderTopLeftRadius};
  });
  let result=await bounds(); assert.equal(result.left,0);assert.equal(result.right,0);assert.ok(result.height<result.groupHeight);assert.equal(result.radius,'6px');
  await page.screenshot({path:'/tmp/v2ex-highlight-multiple.png'});
  await page.locator('#r_50').evaluate(el=>el.remove());
  result=await bounds();assert.equal(result.height,result.groupHeight);
  await page.screenshot({path:'/tmp/v2ex-highlight-single.png'});
  // Parent unread status must not paint a read child's badge.
  await page.evaluate(()=>{mark([36]);replyApi.markUnread({firstVisit:false,lastReadFloor:49},[{floorNum:49,element:document.getElementById('r_49'),floorEl:document.querySelector('#r_49 .no')}]);});
  assert.equal(await page.locator('#r_49 .no').evaluate(el=>getComputedStyle(el).color),'rgb(204, 204, 204)');
  console.log('PASS modern headers, light/dark badges, parent-child isolation, group-aligned single/multiple reply outlines');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
