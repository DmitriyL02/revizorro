// Local diagnostic: executes the actual content script in Node, with only the
// DOM/Chrome boundaries stubbed. Synthetic fixtures contain no student data.
// Exit 1 means a reproduced defect; this is not a passing regression suite.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(require.resolve('../extension/content.js'), 'utf8');
let scripts = [];
let observerCallback;
let scheduled = 0;
const context = vm.createContext({
  document: {
    readyState: 'loading',
    addEventListener() {},
    querySelectorAll(selector) { return selector === 'script' ? scripts : []; },
    getElementById() { return null; },
    body: {},
  },
  MutationObserver: class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  },
  setTimeout() { scheduled++; },
  clearTimeout() {},
});
// Expose private functions only in the in-memory test copy, not the extension.
for (const dependency of ['line-diff.js', 'review-history.js']) vm.runInContext(fs.readFileSync(require.resolve('../extension/' + dependency), 'utf8'), context);
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
  globalThis.audit = {
    extractPageData, computeLineDiff: globalThis.RevizorroLineDiff.computeLineDiff, findMatchingSourceFile, setupObserver,
    setData(data) { pageData = data; buildFileMaps(); },
    enable() { diffEnabled = true; },
  };
})();`), context);
const api = context.audit;
const fixture = (code = 'new') => ({ apiData: {
  homework: { id: 2, data: { sources: [{ file: 'main.js', source: code }] } },
  history: [{ id: 1, data: { sources: [{ file: 'main.js', source: 'old' }] } }],
  currentReview: { iteration: 2 },
} });
const wrap = data => `__init__.default({}, ${JSON.stringify(data)}, false)`;
function parse(...texts) {
  scripts = texts.map(textContent => ({ textContent }));
  return api.extractPageData();
}
let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
    console.log(`OK: ${name}`);
  } catch {
    failures++;
    console.log(`DEFECT: ${name}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

check('baseline documented bootstrap', parse(wrap(fixture()))?.current[0].source, 'new');
check('whitespace-only bootstrap change',
  parse(`__init__.default({},${JSON.stringify(fixture())},false)`)?.current[0].source ?? null, 'new');
const code = 'const obj = {value: undefined}; fn(x, undefined);';
check('preserve student source verbatim', parse(wrap(fixture(code)))?.current[0].source, code);
check('skip unrelated bootstrap before review bootstrap',
  parse(wrap({ other: true }), wrap(fixture()))?.current[0].source ?? null, 'new');
check('boolean delimiter inside source is not end of bootstrap',
  parse(`__init__.default({}, ${JSON.stringify(fixture('fn(x, false)'))}, true)`)?.current[0].source ?? null,
  'fn(x, false)');

api.setData({ current: [
  { file: 'project-a/src/index.js', source: 'a' },
  { file: 'project-b/src/index.js', source: 'b' },
], previous: [] });
check('ambiguous suffix must not select an arbitrary file', api.findMatchingSourceFile('src/index.js'), null);
check('empty old file must not create a removed blank line',
  api.computeLineDiff('', 'hello').map(entry => ({ type: entry.type, line: entry.line })),
  [{ type: 'added', line: 'hello' }]);

api.enable();
api.setupObserver();
const file = { dataset: { revizorroDiffApplied: 'true' } };
const row = {
  nodeType: 1,
  classList: { contains(name) { return name === 'source-tree__code-line'; } },
  matches(selector) { return selector.split(',').some(s => s.trim() === '.source-tree__code-line'); },
  querySelector() { return null; },
  closest(selector) { return selector === '.source-tree__file' ? file : this.matches(selector) ? this : null; },
};
observerCallback([{ addedNodes: [row], removedNodes: [], target: row }]);
check('replacement code row triggers highlight update', scheduled > 0, true);

const status = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../extension/popup.js'), 'utf8'), {
  URL,
  document: { getElementById(id) { return id === 'status' ? status : {}; } },
  chrome: {
    runtime: { getManifest() { return { content_scripts: [{ matches: ['https://admin.praktikum.yandex-team.ru/office/revisor-review/*'] }] }; } },
    tabs: {
      query(options, callback) { callback([{ id: 1, url: 'https://admin.praktikum.yandex-team.ru/office/revisor-review/example' }]); },
      sendMessage(id, message, callback) { callback(undefined); },
    },
  },
});
check('popup must not claim active without a content-script response', status.className === 'status status--ok', false);

console.log(`\n${failures} reproduced defects (synthetic fixtures; no live Chrome verification).`);
process.exitCode = failures ? 1 : 0;
