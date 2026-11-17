const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(require('node:path').join(__dirname, '../v2ex-tweaks.user.js'), 'utf8');
const moduleCode = source.slice(source.indexOf('  const Replies ='), source.indexOf('  // 6) 功能D'))
  .replace('return { boot };', 'return { createReadState, markUnread, commitReadState };');
const store = new Map();
const context = {CONFIG: {replies: {readKeyPrefix: 'read-'}}, GM: {get: (k,d) => store.has(k) ? store.get(k) : d, set: (k,v) => store.set(k,v)}, document: {dispatchEvent() {}}, Event: class {}};
vm.createContext(context); vm.runInContext(moduleCode + '\nthis.api = Replies;', context);
const rows = floors => floors.map(floorNum => ({floorNum, element: {classList: {add() {}, remove() {}, toggle() {}}}, floorEl: {classList: {toggle() {}}, title: '', removeAttribute() {}}}));
const visit = floors => {
 const state = context.api.createReadState('1'), replies = rows(floors);
 const count = context.api.markUnread(state, replies); context.api.commitReadState(state, replies); return count;
};
assert.equal(visit([51,52,53]), 0, 'first visit to later page is not all new');
assert.equal(visit([51,52,53]), 0, 'reloading a visited later page must not mark all replies new');
assert.equal(visit([51,54,52,53]), 1, 'native thread order must not affect detection');
assert.equal(visit([1,2]), 2, 'unvisited earlier pages must not silently become read');
store.clear(); store.set('read-1', 1);
assert.equal(visit([1,3,4]), 2);
assert.equal(visit([1,3,4]), 0, 'a missing/blocked/deleted floor must not freeze progress');
assert.equal(visit([1,2,3,4,5]), 2, 'newly visible gap and newly appended floor are new');
assert.equal(visit([1,2,3,4,5]), 0);
store.clear(); store.set('read-1', 10);
const olderTab = context.api.createReadState('1');
visit([15,16]); context.api.commitReadState(olderTab, rows([11,12]));
assert.equal(visit([11,12,15,16]), 0, 'stale tab commit must merge latest persisted progress');
assert.equal(visit([13,14,17]), 3);
console.log('PASS later-page reload, sparse floors, reordered replies, legacy migration, gaps and stale tab merging');
