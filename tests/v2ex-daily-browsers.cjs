// Local HTTP fixtures only. Never touches real V2EX accounts or browser profiles.
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium,firefox,webkit}=require('playwright');
const source=fs.readFileSync(require('node:path').join(__dirname,'../v2ex-tweaks.user.js'),'utf8');
const daily=source.slice(source.indexOf('  const Daily = (() => {'),source.indexOf('  // 4) 功能B'));
const roots='/Volumes/extdata/CodexOffload/Caches/ms-playwright';
const binaries={chromium:process.env.CHROMIUM_PATH||`${roots}/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,firefox:process.env.FIREFOX_PATH||`${roots}/firefox-1522/firefox/Nightly.app/Contents/MacOS/firefox`,webkit:process.env.WEBKIT_PATH||`${roots}/webkit-2287/pw_run.sh`};
const sessions=new Map(), sharedGM=new Map();let origin;
const html=(s,body)=>`<!doctype html><meta charset="utf-8"><div id="Top"><a href="/member/${s.member}">${s.member}</a></div><div id="Main">${body}</div>`;
const server=http.createServer((req,res)=>{
 const id=/session=([^;]+)/.exec(req.headers.cookie||'')?.[1],s=sessions.get(id);
 if(!s){res.end('<div id="Top"><a href="/signin">登录</a></div>');return;}
 res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');
 const path=new URL(req.url,origin).pathname;
 if(path==='/mission/daily'){
  s.checks++;
  if(s.failures-->0){res.statusCode=503;res.end('temporary failure');return;}
  const who=s.mismatch?{member:'wrong-account'}:s;
  res.end(html(who,s.claimed?'每日登录奖励已领取 已连续登录 10 天':`<button onclick="location.href='/mission/daily/redeem?once=${id}'">领取</button>已连续登录 9 天`));return;
 }
 if(path==='/mission/daily/redeem'){
  s.redeems++;
  if(!req.headers.referer?.startsWith(origin+'/mission/daily')){s.badReferer++;res.statusCode=403;res.end(html(s,'浏览器有一些奇奇怪怪的设置'));return;}
  if(new URL(req.url,origin).searchParams.get('once')!==id){s.wrongToken++;res.statusCode=403;res.end('wrong token');return;}
  if(!s.unconfirmed)s.claimed=true;
  res.writeHead(302,{Location:'/balance'});res.end();return;
 }
 res.end(html(s,path==='/balance'?'余额':'<a href="/mission/daily">领取今日的登录奖励</a>'));
});
async function setup(browser,id,member,opts={}){
 const s={member,claimed:false,checks:0,redeems:0,failures:0,badReferer:0,wrongToken:0,...opts};sessions.set(id,s);
 const context=await browser.newContext();context.setDefaultTimeout(10000);console.log('CONTEXT',id);await context.addCookies([{name:'session',value:id,url:origin}]);
 await context.exposeFunction('saveGM',(k,v)=>sharedGM.set(k,v));
 await context.addInitScript(({seed,daily})=>{
  if(window.top!==window.self)return;
  const snapshot=new Map(seed),nativeTimer=window.setTimeout.bind(window);
  window.setTimeout=(fn,ms,...args)=>nativeTimer(fn,[2000,5000,10000,20000,40000,60000].includes(ms)?30:ms,...args);
  window.CONFIG={daily:{page:'/mission/daily',storeKey:'daily',requestTimeoutMs:1000,verifyRetries:2,verifyIntervalMs:10}};
  window.GM={get:(k,d)=>snapshot.has(k)?snapshot.get(k):d,set:(k,v)=>{snapshot.set(k,v);window.saveGM(k,v);}};
  window.GM_xmlhttpRequest=()=>{window.gmRequests++;throw Error('extension request must not borrow another container cookie jar');};window.gmRequests=0;
  window.ymd=()=>new Date().toISOString().slice(0,10);window.sleep=ms=>new Promise(r=>setTimeout(r,ms));window.log=()=>{};
  window.eval(daily+'\nwindow.daily=Daily;');
 },{seed:[...sharedGM],daily});
 const page=await context.newPage();await page.goto(origin);console.log('READY',id);return {context,page,s};
}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 try{for(const [name,type]of Object.entries({chromium,firefox,webkit})){
  if(process.env.BROWSER && process.env.BROWSER!==name)continue;
  console.log('START',name);
  const browser=await type.launch({headless:process.env.HEADED!=='1',executablePath:binaries[name],timeout:20000});
  console.log('LAUNCHED',name);
  browser.on('disconnected',()=>console.log('CLOSED',name));
  try{
   sharedGM.clear();sharedGM.set('daily',new Date().toISOString().slice(0,10));
   const a=await setup(browser,name+'a','alice');
   assert.equal(await a.page.evaluate(()=>daily.run()),'claimed',name+' initial claim');
   assert.equal(a.s.redeems,1);assert.equal(a.s.badReferer,0);
   assert.equal(await a.page.evaluate(()=>daily.run()),'already-done');assert.equal(a.s.redeems,1);
   // All contexts share GM persistence but never cookie jars or completion authority.
   const b=await setup(browser,name+'b','bob'),same=await setup(browser,name+'same','alice');
   assert.deepEqual(await Promise.all([b.page.evaluate(()=>daily.run()),same.page.evaluate(()=>daily.run())]),['claimed','claimed']);
   assert.equal(b.s.redeems,1);assert.equal(same.s.redeems,1);
   await a.page.reload();assert.equal(await a.page.evaluate(()=>daily.run()),'already-claimed');assert.equal(a.s.redeems,1);
   const wrong=await setup(browser,name+'wrong','carol',{mismatch:true});
   assert.equal(await wrong.page.evaluate(()=>daily.run()),'failed');assert.equal(wrong.s.redeems,0);await wrong.context.close();
   const retry=await setup(browser,name+'retry','retry',{failures:4});
   await retry.page.evaluate(()=>daily.run());await retry.page.waitForFunction(()=>document.querySelector('a[href="/mission/daily"]').textContent.includes('已领取'),{},{timeout:15000});
   assert.equal(retry.s.redeems,1);assert.ok(retry.s.checks>=6);
   const unconfirmed=await setup(browser,name+'unconfirmed','unconfirmed',{unconfirmed:true});
   assert.equal(await unconfirmed.page.evaluate(()=>daily.run()),'failed');assert.equal(sharedGM.has('daily:member:unconfirmed'),false);await unconfirmed.context.close();
   const lock=await setup(browser,name+'lock','lock');const owner=await lock.context.newPage();await owner.goto(origin);
   await owner.evaluate(()=>new Promise(ready=>navigator.locks.request('v2ex-daily:lock',()=>new Promise(()=>ready()))));
   assert.equal(await lock.page.evaluate(()=>daily.run()),'locked');assert.equal(lock.s.redeems,0);
   await owner.close();await lock.page.waitForFunction(()=>document.querySelector('a[href="/mission/daily"]').textContent.includes('已领取'),{},{timeout:10000});assert.equal(lock.s.redeems,1);
   for(const t of [a,b,same,retry,lock]){assert.equal(await t.page.evaluate(()=>gmRequests),0);assert.equal(t.s.badReferer,0);assert.equal(t.s.wrongToken,0);await t.context.close();}
   console.log(`PASS ${name} ${browser.version()}: cookies isolated + shared GM, same username contexts, server recheck, account mismatch, >3 retries, unconfirmed success rejected, page-close lock takeover`);
  }finally{await browser.close();}
 }}finally{server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
