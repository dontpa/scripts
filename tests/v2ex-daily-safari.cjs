const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../v2ex-tweaks.user.js'), 'utf8');
const daily = source.slice(source.indexOf('  const Daily = (() => {'), source.indexOf('  // 4) 功能B'));
async function scenario({already = false, confirm = true} = {}) {
  let serverClaimed = already, claims = 0, checks = 0, removed = 0, timerId = 0;
  const timers = new Map(), store = new Map();
  const label = {textContent:'领取今日的登录奖励'};
  const doc = (claimed = false) => ({
    body: {textContent: claimed ? '每日登录奖励已领取' : '已连续登录 10 天', appendChild() {}},
    documentElement: {innerHTML:''},
    querySelector(s) { return s === '#Top a[href^="/member/"]' ? {getAttribute:()=>'/member/test'} : null; },
    querySelectorAll() { return claimed ? [] : [{getAttribute:n=>n==='onclick'?"location.href='/mission/daily/redeem?once=test'":null}]; },
  });
  const main = doc();
  main.querySelectorAll = () => [label];
  main.body.appendChild = frame => queueMicrotask(()=>frame.load());
  main.createElement = () => {
    const frame = {dataset:{},setAttribute(){},remove(){removed++;},addEventListener(_,fn){this.load=fn;}};
    const updateDoc = path => {
      frame.contentWindow = {location:{href:'https://edge.v2ex.com'+path}};
      frame.contentDocument = doc(path === '/balance' ? false : serverClaimed);
      if (path === '/balance') { frame.contentDocument.body.textContent = '账户余额'; frame.contentDocument.querySelectorAll = () => []; }
      frame.contentDocument.createElement = () => ({click(){claims++; if(confirm)serverClaimed=true;updateDoc('/balance');queueMicrotask(()=>frame.load());}});
    };
    Object.defineProperty(frame,'src',{set(value){checks++;updateDoc(new URL(value).pathname);if(this.load)queueMicrotask(()=>this.load());},get(){return 'https://edge.v2ex.com/mission/daily';}});
    return frame;
  };
  const context = {
    URL,Date,Promise,Math,document:main,globalThis:{},
    navigator:{userAgent:'AppleWebKit',vendor:'Apple Computer, Inc.',locks:{request:async(_,o,fn)=>fn({})}},
    location:{origin:'https://edge.v2ex.com',href:'https://edge.v2ex.com/'},
    CONFIG:{daily:{page:'/mission/daily',storeKey:'daily',requestTimeoutMs:12000,verifyRetries:2,verifyIntervalMs:1}},
    GM:{get:(k,f)=>store.get(k)??f,set:(k,v)=>store.set(k,v)},
    ymd:()=> '2026-10-07',log(){},
    setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,ms});if(ms===1)queueMicrotask(()=>{if(timers.delete(id))fn();});return id;},
    clearTimeout(id){timers.delete(id);},
  };
  vm.createContext(context); vm.runInContext(daily+'\nglobalThis.daily=Daily;',context);
  const result = await context.globalThis.daily.run();
  if (already || confirm) {
    assert.equal(result, already ? 'already-claimed' : 'claimed');
    assert.equal(store.get('daily:member:test'),'2026-10-07');
    assert.equal(label.textContent,'今日登录奖励已领取');
    assert.equal(timers.size,0);
  } else {
    assert.equal(result,'failed');
    assert.equal(store.has('daily:member:test'),false);
    assert.equal(label.textContent,'领取今日的登录奖励');
    assert.equal([...timers.values()][0].ms,5000);
  }
  assert.equal(claims,already?0:1);
  assert.ok(removed>=1);
  if(!already) assert.ok(checks>=2,'must verify with server after redeem');
}
(async()=>{await scenario();await scenario({already:true});await scenario({confirm:false});console.log('PASS Safari iframe claim, server verification, already-claimed, unconfirmed retry, cleanup, homepage update');})();
