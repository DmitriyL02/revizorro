const { test } = require('node:test');
const assert = require('node:assert/strict');
let selectHistory;
try { ({ selectHistory } = require('../extension/review-history.js')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const entry = (id, day, sources = [{ file: 'main.js', source: String(id) }]) => ({
  id, ...(day ? { created_at: `2026-10-${day}T12:00:00Z` } : {}), data: { sources },
});
const current = entry('current', '20');

test('selects actual latest prior and sorts shuffled history oldest first', () => {
  assert.equal(typeof selectHistory, 'function');
  const oldest = entry('oldest', '01'), latest = entry('latest', '19');
  for (const history of [[latest, oldest], [oldest, latest]]) {
    const result = selectHistory(current, history, { iteration: 3 });
    assert.deepEqual(result.previous, latest.data.sources);
    assert.deepEqual(result.allIterations.map(x => x.historyEntry.id), ['oldest', 'latest']);
    assert.deepEqual(result.allIterations.map(x => x.label), ['Итерация 1', 'Итерация 2']);
    assert.match(result.allIterations[0].title, /2026-10-01/);
  }
});
test('deduplicates ids and excludes current and strictly later entries', () => {
  const old = entry('old', '10');
  const result = selectHistory(current, [current, old, structuredClone(old), entry('later', '21')]);
  assert.deepEqual(result.allIterations.map(x => x.historyEntry.id), ['old']);
});
test('same-second distinct submissions remain manual candidates without an automatic previous', () => {
  const simultaneous = entry('same-time', '20');
  for (const history of [[simultaneous], [entry('older', '19'), simultaneous]]) {
    const result = selectHistory(current, history);
    assert.ok(result.allIterations.some(row => row.historyEntry === simultaneous));
    assert.equal(result.previous, null);
  }
});
test('does not equate missing ids and preserves valid empty sources', () => {
  const result = selectHistory(entry(undefined, '20'), [entry(undefined, '01'), entry(undefined, '19', [])]);
  assert.equal(result.allIterations.length, 2);
  assert.deepEqual(result.previous, []);
});
test('missing or invalid metadata requires manual selection with explicit labels', () => {
  const known = entry('known', '10'), unknown = entry('unknown');
  const invalid = { ...entry('invalid'), created_at: 'yesterday' };
  for (const history of [[known, unknown, invalid], [invalid, unknown, known]]) {
    const result = selectHistory(current, history);
    assert.equal(result.previous, null);
    assert.deepEqual(result.allIterations.map(x => x.historyEntry.id), ['known', 'invalid', 'unknown']);
    assert.match(result.allIterations[1].label, /порядок неизвестен/);
  }
  assert.equal(selectHistory(entry('current'), [known]).previous, null);
});
test('equal latest timestamps cannot identify a unique previous submission', () => {
  assert.equal(selectHistory(current, [entry('a', '19'), entry('b', '19')]).previous, null);
});
test('conflicting duplicate metadata cannot silently choose a previous submission', () => {
  assert.equal(selectHistory(current, [entry('a', '01'), entry('a', '19'), entry('b', '10')]).previous, null);
});
test('exports the same helper as a browser global', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../extension/review-history.js'), 'utf8'), context);
  assert.equal(typeof context.RevizorroReviewHistory.selectHistory, 'function');
});
test('rejects malformed entries and sources while retaining valid history', () => {
  const old = entry('old', '01');
  const result = selectHistory(current, [null, 42, {}, { data: { sources: {} } },
    { data: { sources: [null] } }, { data: { sources: [{ file: 'a', source: 1 }] } }, old]);
  assert.deepEqual(result.previous, old.data.sources);
  assert.deepEqual(selectHistory(current, {}), { previous: null, allIterations: [] });
});
