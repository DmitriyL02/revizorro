const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const sourcePath = path.join(__dirname, '../extension/line-diff.js');
const computeLineDiff = fs.existsSync(sourcePath) ? require(sourcePath).computeLineDiff : undefined;

function lines(text) { return text ? text.split('\n') : []; }
function lcsLength(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] = a[i - 1] === b[j - 1] ? table[i - 1][j - 1] + 1 : Math.max(table[i - 1][j], table[i][j - 1]);
    }
  }
  return table[a.length][b.length];
}
function verify(oldText, newText, expectedEdits) {
  assert.equal(typeof computeLineDiff, 'function', 'exact line diff must be exported');
  const a = lines(oldText), b = lines(newText);
  const diff = computeLineDiff(oldText, newText);
  let i = 0, j = 0, edits = 0;
  for (const row of diff) {
    assert.ok(['context', 'removed', 'added'].includes(row.type));
    if (row.type !== 'added') {
      assert.equal(row.line, a[i]);
      assert.equal(row.oldNum, ++i);
    } else assert.equal(row.oldNum, undefined);
    if (row.type !== 'removed') {
      assert.equal(row.line, b[j]);
      assert.equal(row.newNum, ++j);
    } else assert.equal(row.newNum, undefined);
    if (row.type !== 'context') edits++;
  }
  assert.equal(i, a.length);
  assert.equal(j, b.length);
  assert.equal(edits, expectedEdits ?? a.length + b.length - 2 * lcsLength(a, b));
  return diff;
}

test('empty input and real blank lines retain correct semantics', () => {
  assert.deepEqual(verify('', ''), []);
  verify('', '\n');
  verify('\n', '');
  verify('a\n\nb\n', '\na\nb\n\n');
  verify('one', 'different');
});

test('repeated and reordered lines produce a minimal sequence-preserving script', () => {
  verify('a\nb\na\nb', 'b\na\nb\na');
  verify('a\na\na', 'a\nb\na');
  verify('x\na\nb\na\ny', 'z\nb\na\nb\nw');
});

test('random small repeated lines agree with independent full-table LCS oracle', () => {
  let seed = 1234567;
  function random(n) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); }
  const alphabet = ['', 'a', 'b', 'c'];
  for (let trial = 0; trial < 1500; trial++) {
    const a = Array.from({ length: random(18) }, () => alphabet[random(4)]).join('\n');
    const b = Array.from({ length: random(18) }, () => alphabet[random(4)]).join('\n');
    verify(a, b);
  }
});

test('above old two-million-cell threshold, a rotated repeated block remains minimal', () => {
  const a = [...Array(1500).fill('a'), 'b'];
  const b = ['b', ...Array(1500).fill('a')];
  verify(a.join('\n'), b.join('\n'), 2);
});

test('large nearly identical files preserve numbering and trim shared edges', () => {
  const a = Array.from({ length: 100000 }, (_, i) => `line ${i}`);
  const b = a.slice();
  b[50000] = 'replacement';
  verify(a.join('\n'), b.join('\n'), 2);
});

test('script exposes browser global without CommonJS or dependencies', () => {
  assert.ok(fs.existsSync(sourcePath), 'browser line diff script must exist');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context);
  assert.equal(typeof context.RevizorroLineDiff.computeLineDiff, 'function');
  assert.equal(context.RevizorroLineDiff.computeLineDiff('a', 'a')[0].type, 'context');
});

const asyncDiff = (...args) => {
  const fn = require(sourcePath).computeLineDiffAsync;
  assert.equal(typeof fn, 'function', 'cooperative diff must be exported');
  return fn(...args);
};

test('large exact diff lets timers run before it completes', async () => {
  const n = 2000;
  const a = Array.from({ length: n }, (_, i) => `old ${i}`).join('\n');
  const b = Array.from({ length: n }, (_, i) => `new ${i}`).join('\n');
  let finished = false;
  const pending = asyncDiff(a, b).then(result => { finished = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(finished, false, 'input events must be able to run during calculation');
  const result = await pending;
  assert.equal(result.length, 2 * n);
  assert.equal(result.filter(row => row.type === 'context').length, 0);
  assert.deepEqual(result.filter(row => row.type === 'removed').map(row => row.line), lines(a));
  assert.deepEqual(result.filter(row => row.type === 'added').map(row => row.line), lines(b));
});

test('cancelled calculation stops without publishing a partial diff', async () => {
  let cancelled = false;
  const a = Array(5000).fill('old').join('\n');
  const b = Array(5000).fill('new').join('\n');
  const pending = asyncDiff(a, b, { isCancelled: () => cancelled });
  await new Promise(resolve => setTimeout(resolve, 0));
  cancelled = true;
  assert.equal(await pending, null);
  assert.deepEqual(await asyncDiff('a\nb', 'a\nc'), [
    { type: 'context', line: 'a', oldNum: 1, newNum: 1 },
    { type: 'removed', line: 'b', oldNum: 2 },
    { type: 'added', line: 'c', newNum: 2 },
  ]);
});
