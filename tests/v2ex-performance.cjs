// Run with Playwright on NODE_PATH.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined});
 const src=fs.readFileSync(require('node:path').join(__dirname,'../v2ex-tweaks.user.js'),'utf8');
 const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({body:'<body></body>',contentType:'text/html'}));
 await page.goto('https://edge.v2ex.com/t/1');
 await page.evaluate(()=>{
  window.CONFIG={nav:{scrollOffsetRatio:0.3}};window.log=()=>{};window.isTopicPage=()=>true;
  for(let i=0;i<400;i++){
   const el=document.createElement('div');el.className='cell reply-new';el.id='r_'+i;document.body.append(el);
  }
 });
  const nav=src.slice(src.indexOf('  const NavKeys ='),src.indexOf('  // 8) 功能F'));
  await page.evaluate(nav+'\nwindow.nav=NavKeys;');
  const scans=await page.evaluate(()=>{
   window.scans=0;const query=document.querySelectorAll.bind(document);
   document.querySelectorAll=(selector)=>{if(selector==='div.cell.reply-new[id^="r_"]')window.scans++;return query(selector);};
  });
  // module const persists in this browser realm
  await page.evaluate('window.nav.boot();');
  await page.evaluate(()=>{for(let i=0;i<20;i++)document.dispatchEvent(new KeyboardEvent('keydown',{key:'j'}));});
   assert.equal(await page.evaluate(()=>window.scans),1);
   await page.evaluate(()=>{document.dispatchEvent(new Event('v2ex:replies-updated'));document.dispatchEvent(new KeyboardEvent('keydown',{key:'j'}));});
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
   await page.evaluate(()=>{
    CONFIG.imgur={proxyEnabled:true,storeKey:'test-imgur'};
    window.GM={get:(_key,fallback)=>fallback,set:()=>true,onChange:()=>{}};
    window.createToggleMenu=()=>()=>{};
   });
   await page.evaluate(img+'\nImgurProxy.boot();');
   await page.evaluate(()=>{const root=document.createElement('div');document.body.append(root);const image=document.createElement('img');root.append(image);image.src='https://i.imgur.com/example.png';image.id='proxy-test';});
   await page.waitForTimeout(50);
   assert.match(await page.locator('#proxy-test').getAttribute('src'),/^https:\/\/external-content\.duckduckgo\.com/);
   console.log('PASS dynamically inserted Imgur image proxied once');
  await page.close();
 await browser.close();
})();
