const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname,'../v2ex-tweaks.user.js'),'utf8');
const daily = source.slice(source.indexOf('  const Daily = (() => {'),source.indexOf('  // 4) 功能B'));
(async()=>{
 let now=1000000, requests=0, id=0;
 const timers=new Map(), store=new Map();
 const baseKey='daily', key=baseKey+':member:wangc', today='2026-09-21';
 let member='wangc', responseMember='wangc';
 const doc=(name,claimed=false)=>({body:{textContent:''},querySelector:s=>s==='#Top a[href^="/member/"]'?{getAttribute:()=>'/member/'+name}:s==='#Main .fa-ok-sign'&&claimed?{}:null});
 store.set(baseKey,today);
 store.set(baseKey+':member:vivaldi',today);
 store.set(key+'_lock',{date:today,startedAt:now-240000,token:'abandoned'});
 const context={URL,AbortController,Date:{now:()=>now},Math,Promise,globalThis:{},navigator:{userAgent:'Firefox',vendor:''},
 CONFIG:{daily:{page:'/mission/daily',storeKey:baseKey,delayMinMs:0,delayMaxMs:0,verifyRetries:1,verifyIntervalMs:1,requestTimeoutMs:12000,networkRetries:0}},
 location:{origin:'https://edge.v2ex.com',href:'https://edge.v2ex.com/'},
 document:{querySelector:s=>doc(member).querySelector(s)},
 GM:{get:(k,d)=>store.has(k)?store.get(k):d,set:(k,v)=>store.set(k,v)},
 GM_xmlhttpRequest:()=>{throw new Error('Firefox must not use extension cookie jar');},
 fetch:async(url,opts)=>{requests++;assert.equal(opts.credentials,'include');return {ok:true,url,text:async()=>responseMember};},
 DOMParser:class{parseFromString(text){return doc(text,true);}},
 sleep:async()=>{},randInt:()=>0,ymd:()=>today,log:()=>{},notify:()=>{},
 setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:i=>timers.delete(i)};
 vm.createContext(context);vm.runInContext(daily+'\nglobalThis.daily=Daily;',context);
 const api=context.globalThis.daily;
 assert.equal(await api.run(),'locked');assert.equal(requests,0);
 assert.equal(timers.size,1);
 const retry=[...timers.values()][0];assert.equal(retry.ms,60100);
 now+=retry.ms;timers.clear();
 assert.equal(await retry.fn(),'already-claimed');assert.equal(requests,1);
 assert.equal(store.get(key),today);assert.equal(store.get(key+'_lock'),null);
 assert.equal(await api.run(),'already-done');assert.equal(requests,1);
 member='vivaldi';responseMember='vivaldi';
 assert.equal(await api.run(),'already-done');assert.equal(requests,1);
 member='another';responseMember='vivaldi';
 assert.equal(await api.run(),'failed');
 assert.equal(store.has(baseKey+':member:another'),false);
 responseMember='another';assert.equal(await api.run(),'already-claimed');
 assert.equal(store.get(baseKey+':member:another'),today);
 member='';const before=requests;assert.equal(await api.run(),'signed-out');assert.equal(requests,before);
 console.log('PASS account-isolated success and locks, legacy global state ignored, Firefox page fetch, account mismatch rejected');
 console.log('PASS active lock prevents duplicate claim; abandoned lock retries on expiry; server confirmation stores success and clears lock');
})();
