const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const content = fs.readFileSync(require.resolve('../extension/content.js'), 'utf8');
function extract(...scripts) {
  const context = vm.createContext({ document: {
    readyState: 'loading', addEventListener() {},
    querySelectorAll() { return scripts.map(textContent => ({ textContent })); },
  } });
  for (const dependency of ['line-diff.js', 'review-history.js']) vm.runInContext(fs.readFileSync(require.resolve('../extension/' + dependency), 'utf8'), context);
  vm.runInContext(content.replace(/\}\)\(\);\s*$/, 'globalThis.extract = extractPageData; })();'), context);
  return JSON.parse(JSON.stringify(context.extract()));
}
const sources = [{ file: 'src/main.js', source: 'const x = {value: undefined}; fn(x, undefined);' }];
const data = { apiData: {
  homework: { id: 'new', created_at: '2026-10-29T12:00:00Z', data: { sources } },
  history: [{ id: 'old', created_at: '2026-10-28T12:00:00Z', data: { sources: [{ file: 'src/main.js', source: 'old' }] } }],
  currentReview: { iteration: 2 },
} };
const legacy = value => `__init__.default({}, ${JSON.stringify(value)}, false);`;
const modern = value => `window.wirthAdminBootstrap = ${JSON.stringify({ state: {}, data: value })};`;

for (const [name, wrap] of [['legacy', legacy], ['current', modern]]) {
  test(`${name}: reads review and preserves source verbatim`, () => {
    const result = extract(wrap(data));
    assert.deepEqual(result?.current, sources);
    assert.equal(result.previous[0].source, 'old');
    assert.equal(result.iteration, 2);
  });
  test(`${name}: allows undefined values outside strings`, () => {
    const script = wrap(data).replace('"apiData":{', '"apiData":{"errors":undefined,');
    assert.deepEqual(extract(script)?.current, sources);
  });
  test(`${name}: continues past invalid and unrelated scripts`, () => {
    assert.deepEqual(extract(wrap({ unrelated: true }), 'window.wirthAdminBootstrap = {bad};', wrap(data))?.current, sources);
  });
}
test('legacy accepts whitespace changes and true flag with false delimiter in source', () => {
  const value = structuredClone(data);
  value.apiData.homework.data.sources[0].source = 'fn(x, false)';
  const result = extract(`__init__.default( { },\n${JSON.stringify(value)},true);`);
  assert.equal(result?.current[0].source, 'fn(x, false)');
});
test('current handles braces, quotes, escapes and trailing JavaScript without executing it', () => {
  const value = structuredClone(data);
  value.apiData.homework.data.sources[0].source = '"}\\\\\\\""; // {, undefined';
  const result = extract(`${modern(value)} throw new Error('must never execute');`);
  assert.deepEqual(result?.current, value.apiData.homework.data.sources);
});
test('malformed/truncated bootstrap fails closed', () => {
  assert.equal(extract('window.wirthAdminBootstrap = {"data":'), null);
});
test('does not execute expressions in bootstrap', () => {
  assert.equal(extract('window.wirthAdminBootstrap = {"data": (() => { throw Error("unsafe"); })()};'), null);
});
