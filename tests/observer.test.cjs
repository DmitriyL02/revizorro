const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  let callback;
  let scheduled = 0;
  const ctx = vm.createContext({
    document: { readyState: 'loading', addEventListener() {}, getElementById() {}, body: {} },
    MutationObserver: class { constructor(cb) { callback = cb; } observe() {} disconnect() {} },
    clearTimeout() {}, setTimeout() { scheduled++; },
  });
  const source = fs.readFileSync(require.resolve('../extension/content.js'), 'utf8');
  for (const dependency of ['line-diff.js', 'review-history.js']) vm.runInContext(fs.readFileSync(require.resolve('../extension/' + dependency), 'utf8'), ctx);
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'diffEnabled=true; setupObserver(); })();'), ctx);
  return { emit(mutation) { callback([mutation]); }, scheduled: () => scheduled };
}
function element(classes, file) {
  return {
    nodeType: 1,
    classList: { contains: name => classes.includes(name) },
    matches: selector => selector.split(',').some(s => classes.includes(s.trim().slice(1))),
    querySelector() { return null; },
    closest(selector) {
      if (selector === '.source-tree__file') return file;
      return this.matches(selector) ? this : null;
    },
  };
}
for (const type of ['added', 'removed', 'text']) {
  test(`re-rendered code (${type}) invalidates highlighting and schedules refresh`, () => {
    const h = harness();
    const file = { dataset: { revizorroDiffApplied: 'true' } };
    const row = element(['source-tree__code-line'], file);
    const area = element(['source-tree__code'], file);
    h.emit({ type: type === 'text' ? 'characterData' : 'childList',
      target: type === 'text' ? { nodeType: 3, parentElement: row } : area,
      addedNodes: type === 'added' ? [row] : [], removedNodes: type === 'removed' ? [row] : [] });
    assert.equal(file.dataset.revizorroDiffApplied, undefined);
    assert.equal(h.scheduled(), 1);
  });
}
test('injected removed rows do not schedule another rendering pass', () => {
  const h = harness();
  const row = element(['source-tree__code-line', 'revizorro-injected']);
  h.emit({ type: 'childList', target: element(['source-tree__code']), addedNodes: [row], removedNodes: [row] });
  assert.equal(h.scheduled(), 0);
});
