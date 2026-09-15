// Run with Playwright on NODE_PATH. Optional V2EX_BASELINE_FILE enables timing comparison.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
 let baselineDigest=null;
 const current=require('node:path').join(__dirname,'../v2ex-tweaks.user.js');
 for(const file of [process.env.V2EX_BASELINE_FILE,current].filter(Boolean)){
  const src=fs.readFileSync(file,'utf8'); const page=await browser.newPage();
  await page.route('**/*',r=>r.fulfill({body:'<body></body>',contentType:'text/html'}));await page.goto('https://edge.v2ex.com/t/1');
  await page.evaluate(()=>{window.CONFIG={threadTree:{collapseKeyPrefix:'test-'},nav:{scrollOffsetRatio:0.3}};window.log=()=>{};window.isTopicPage=()=>true;});
  const module=src.slice(src.indexOf('  const ThreadTree ='),src.indexOf('  // 6) 功能D')).replace('return { boot, revealAncestors };','return { boot, revealAncestors, renderTree, buildLookupMaps, markUnread'+(file===current?', buildReplyForest':'')+' };');
  await page.evaluate(module+'\nwindow.tree=ThreadTree;');
  const times=await page.evaluate(()=>{
   const box=document.createElement('div');box.className='box';document.body.append(box);
   const rows=Array.from({length:400},(_,i)=>{
    const element=document.createElement('div');element.className='cell';element.id='r_'+i;
    element.innerHTML='<strong><a>user</a></strong><span class="ago">1h</span><div class="fr"><span class="no">'+i+'</span></div><div class="reply_content">reply text</div>';
    return {element,id:String(i),index:i,floorNum:i+1,memberName:'user',refFloors:i?[String(i)]:undefined,children:[],floorEl:element.querySelector('.no')};
   });window.rows=rows;window.box=box;const maps=tree.buildLookupMaps(rows);let ms=[];
   for(let i=0;i<5;i++){const start=performance.now();tree.renderTree(rows,maps,box,'bench');ms.push(performance.now()-start);}
   const assertCount=box.querySelectorAll('.cell').length;
   return {ms,count:assertCount};
   });assert.equal(times.count,400);
  const digest=require('node:crypto').createHash('sha256').update(await page.evaluate(()=>box.innerHTML)).digest('hex');
  if(file!==current) baselineDigest=digest;
  else if(baselineDigest) {assert.equal(digest,baselineDigest);console.log('PASS rendered DOM exactly matches baseline');}
  const nav=src.slice(src.indexOf('  const NavKeys ='),src.indexOf('  // 8) 功能F'));
  await page.evaluate('window.ThreadTree=window.tree;\n'+nav+'\nwindow.nav=NavKeys;');
  const scans=await page.evaluate(()=>{
   tree.markUnread({firstVisit:false,lastReadFloor:0},rows);
   window.scans=0;const query=document.querySelectorAll.bind(document);
   document.querySelectorAll=(selector)=>{if(selector==='.reply-new')window.scans++;return query(selector);};
  });
  // module const persists in this browser realm
  await page.evaluate('window.nav.boot();');
  await page.evaluate(()=>{for(let i=0;i<20;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'j'}));});
  console.log(file,JSON.stringify({render:times,navScans:await page.evaluate(()=>window.scans)}));
  if(file===current){
   const large=await page.evaluate(()=>{
    const rows=Array.from({length:20000},(_,i)=>({id:String(i),index:i,floorNum:i+1,memberName:'chain',refFloors:i?[String(i)]:undefined}));
    const forest=tree.buildReplyForest(rows,tree.buildLookupMaps(rows));
    return {roots:forest.roots.length,count:forest.counts.get(rows[0])};
   });
   assert.deepEqual(large,{roots:1,count:19999});
   console.log('PASS 20,000-level forest without recursive calls');
   assert.equal(await page.evaluate(()=>window.scans),1);
   await page.evaluate(()=>{tree.renderTree(rows,tree.buildLookupMaps(rows),box,'bench');document.dispatchEvent(new KeyboardEvent('keydown',{key:'j'}));});
   assert.equal(await page.evaluate(()=>window.scans),2);
   const helper=src.slice(src.indexOf('  function createSubtreeBatch'),src.indexOf('  function notify'));
   await page.evaluate('(()=>{'+helper+'\nwindow.makeBatch=createSubtreeBatch;window.createSubtreeBatch=createSubtreeBatch;})()');
   const batch=await page.evaluate(async()=>{
    const root=document.createElement('div'),child=document.createElement('span');root.append(child);document.body.append(root);
    const gone=document.createElement('div');let visits=[];
    const enqueue=makeBatch(node=>visits.push(node===root?'root':'other'),10);
    enqueue(child);enqueue(root);enqueue(child);enqueue(gone);
    await new Promise(r=>setTimeout(r,40));return visits;
    });assert.deepEqual(batch,['root']);console.log('PASS subtree coalescing, detached-node filtering, nav invalidation');
   await page.evaluate(()=>{CONFIG.b64={minLen:8,targetSelectors:['.reply_content'],excludeList:[],entropyThreshold:3};});
   const b64=src.slice(src.indexOf('  const B64 ='),src.indexOf('  // 5) 功能C'));
   const entropy=src.slice(src.indexOf('  function shannonEntropy'),src.indexOf('  // =========================',src.indexOf('  function shannonEntropy')));
   await page.evaluate('(()=>{'+entropy+b64+'\nwindow.b64=B64;})()');
   await page.evaluate(()=>{
    const el=document.createElement('div');el.id='incremental';el.className='reply_content';document.body.append(el);window.b64.boot();
    el.remove();document.body.append(el);
    const span=document.createElement('span');el.append(span);
    span.append(document.createTextNode(btoa('This is an incremental reply containing readable text.')));
   });
   await page.waitForTimeout(350);
   assert.equal(await page.locator('#incremental .v2-b64-wrap').count(),1);
   console.log('PASS B64 moved scanned container with newly appended nested text');
   const img=src.slice(src.indexOf('  const ImgurProxy ='),src.indexOf('  // 9) 功能G'));
   await page.evaluate(img+'\nImgurProxy.boot();');
   await page.evaluate(()=>{const root=document.createElement('div');document.body.append(root);const image=document.createElement('img');root.append(image);image.src='https://i.imgur.com/example.png';image.id='proxy-test';});
   await page.waitForTimeout(50);
   assert.match(await page.locator('#proxy-test').getAttribute('src'),/^https:\/\/external-content\.duckduckgo\.com/);
   console.log('PASS dynamically inserted Imgur image proxied once');
  }
  await page.close();
 }
 await browser.close();
})();
