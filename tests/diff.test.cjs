const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const ctx = vm.createContext({ setTimeout, performance, document: { readyState: 'loading', addEventListener() {},
    createElement() { return { appendChild() {} }; },
  } });
  const text = fs.readFileSync(require.resolve('../extension/content.js'), 'utf8');
  for (const dependency of ['line-diff.js', 'review-history.js']) vm.runInContext(fs.readFileSync(require.resolve('../extension/' + dependency), 'utf8'), ctx);
  vm.runInContext(text.replace(/\}\)\(\);\s*$/, `globalThis.api = {
    set(current, previous) { pageData = {current, previous}; invalidateCaches(); buildFileMaps(); },
    diff: getDiffForFile, lines: globalThis.RevizorroLineDiff.computeLineDiff, match: findMatchingSourceFile, render: applyDiffToCodeBlock,
    stats() { return [...computeFolderStats()]; }
  }; })();`), ctx);
  return ctx.api;
}
const file = (file, source = 'same') => ({ file, source });
const plain = value => JSON.parse(JSON.stringify(value));

test('renamed archive root leaves unchanged files and folder statistics unchanged', async () => {
  const a = load();
  const old = [file('project-main/app.py'), file('project-main/lib/utils.py')];
  a.set([file('project-final/app.py'), file('project-final/lib/utils.py')], old);
  assert.deepEqual(plain(await a.diff('project-final/app.py')), [{ type: 'context', line: 'same', oldNum: 1, newNum: 1 }]);
  assert.deepEqual(plain(a.stats()), []);
  assert.equal(old[0].file, 'project-main/app.py');
});
test('renamed root preserves real additions, modifications and deletions', async () => {
  const a = load();
  a.set([file('new/a.py', 'new'), file('new/added.py')], [file('old/a.py', 'old'), file('old/deleted.py')]);
  assert.deepEqual(plain(a.stats()), [['new', { added: 1, modified: 1, removed: 1, deletedFiles: ['deleted.py'] }]]);
  assert.equal((await a.diff('new/a.py')).filter(x => x.type === 'removed')[0].line, 'old');
});
test('multiple roots and changed inner paths are not merged by basename', async () => {
  const a = load();
  a.set([file('one/a.py'), file('two/a.py')], [file('old/a.py')]);
  assert.equal(a.match('a.py'), null);
  assert.equal((await a.diff('one/a.py')).some(x => x.type === 'context'), false);
  a.set([file('root/new/a.py')], [file('root/old/a.py')]);
  assert.equal((await a.diff('root/new/a.py')).some(x => x.type === 'context'), false);
});
test('unrelated single roots with no relative path overlap are not aligned', () => {
  const a = load();
  a.set([file('new/a.py')], [file('old/b.py')]);
  assert.equal(a.match('new/b.py'), null);
});
test('unique suffix resolves even when present in both versions; ambiguous suffix fails closed', () => {
  const a = load();
  a.set([file('root/src/a.py')], [file('root/src/a.py')]);
  assert.equal(a.match('src/a.py'), 'root/src/a.py');
  a.set([file('one/src/a.py'), file('two/src/a.py')], []);
  assert.equal(a.match('src/a.py'), null);
  assert.equal(a.match('one/src/a.py'), 'one/src/a.py');
});
test('switching comparison rebuilds root alignment and cached diff', async () => {
  const a = load();
  a.set([file('now/a.py')], [file('old/a.py')]);
  await a.diff('now/a.py');
  a.set([file('now/a.py')], [file('older/a.py', 'different')]);
  assert.equal((await a.diff('now/a.py')).find(x => x.type === 'removed').line, 'different');
});
test('empty files do not generate fictitious lines; real blank lines remain', () => {
  const a = load();
  assert.deepEqual(plain(a.lines('', '')), []);
  assert.deepEqual(plain(a.lines('', 'hello')), [{ type: 'added', line: 'hello', newNum: 1 }]);
  assert.deepEqual(plain(a.lines('hello', '')), [{ type: 'removed', line: 'hello', oldNum: 1 }]);
  assert.equal(a.lines('', '\n').filter(x => x.type === 'removed').length, 0);
});
test('file emptied in a viewer with blank row 1 renders each deletion once', () => {
  const a = load();
  const inserted = [];
  const parent = { insertBefore(node) { inserted.push(node); }, appendChild(node) { inserted.push(node); } };
  const row = { parentElement: parent, querySelector() { return { textContent: '1' }; } };
  a.render({}, [row], a.lines('old', ''));
  assert.equal(inserted.length, 1);
});
