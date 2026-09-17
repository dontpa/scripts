const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname,'../v2ex-tweaks.user.js'),'utf8');
const daily = source.slice(source.indexOf('  const Daily = (() => {'),source.indexOf('  // 4) 功能B'));
(async()=>{
 let now=1000000, requests=0, id=0;
 const timers=new Map(), store=new Map();
 const key='daily', today='2026-09-17';
 store.set(key+'_lock',{date:today,startedAt:now-240000,token:'abandoned'});
 const context={URL,Date:{now:()=>now},Math,Promise,globalThis:{},navigator:{userAgent:'Firefox',vendor:''},
 CONFIG:{daily:{page:'/mission/daily',storeKey:key,delayMinMs:0,delayMaxMs:0,verifyRetries:1,verifyIntervalMs:1,requestTimeoutMs:12000,networkRetries:0}},
 location:{origin:'https://edge.v2ex.com',href:'https://edge.v2ex.com/'},
 document:{querySelector:()=>null},
 GM:{get:(k,d)=>store.has(k)?store.get(k):d,set:(k,v)=>store.set(k,v)},
 GM_xmlhttpRequest:opts=>{requests++;opts.onload({status:200,responseText:'claimed',finalUrl:'https://edge.v2ex.com/mission/daily'});},
 DOMParser:class{parseFromString(){return {body:{textContent:''},querySelector:s=>s==='#Main .fa-ok-sign'?{}:null};}},
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
 console.log('PASS active lock prevents duplicate claim; abandoned lock retries on expiry; server confirmation stores success and clears lock');
})();
