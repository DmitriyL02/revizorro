const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const origin = 'https://admin.praktikum.yandex-team.ru';
const route = name => `${origin}/office/revisor-review/${name}`;
const files = (path, source) => [{ file: path, source }];
function bootstrap(name, current, previous) {
  return `window.wirthAdminBootstrap = ${JSON.stringify({ data: { apiData: {
    homework: { id: name, created_at: '2026-10-29T12:00:00Z', data: { sources: current } },
    history: [{ id: `${name}-old`, created_at: '2026-10-28T12:00:00Z', data: { sources: previous } }],
  } } })};`;
}
function html(name, current = files('main.js', name), previous = files('main.js', 'old')) {
  return `<div class="revisor-review"><div class="tabs-group"></div><div class="source-tree"></div></div><script>${bootstrap(name, current, previous)}</script>`;
}
function harness(markup = html('a'), url = route('a')) {
  const dom = new JSDOM(markup, { url, runScripts: 'outside-only' });
  const w = dom.window;
  const intervals = new Map();
  let sequence = 0;
  let now = Date.now();
  w.Date.now = () => now;
  w.setInterval = fn => { const key = ++sequence; intervals.set(key, fn); return key; };
  w.clearInterval = id => intervals.delete(id);
  const timeouts = new Map();
  w.setTimeout = fn => { const key = ++sequence; timeouts.set(key, fn); return key; };
  w.clearTimeout = id => timeouts.delete(id);
  w.chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { local: { get(key, cb) { cb({ [key]: true }); }, set() {} } },
  };
  const requests = [];
  w.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
  for (const file of ['line-diff.js', 'review-history.js']) w.eval(fs.readFileSync(require.resolve(`../extension/${file}`), 'utf8'));
  let script = fs.readFileSync(require.resolve('../extension/content.js'), 'utf8');
  script = script.slice(0, script.lastIndexOf("  if (document.readyState === 'loading')")) + `
    globalThis.testAPI = { init, applyDiffToVisibleFiles, removeDiffHighlights, switchToIteration, disconnectObserver,
      data: () => pageData,
      set(current, previous) { pageData={current,previous,allIterations:[]}; diffEnabled=true; invalidateCaches(); buildFileMaps(); }
    }; })();`;
  w.eval(script);
  const tick = async () => { for (const fn of [...intervals.values()]) fn(); await flush(); };
  return { w, dom, requests, tick, api: w.testAPI, document: w.document,
    advance(ms) { now += ms; },
    async runTimers() {
      const batch = [...timeouts.values()];
      timeouts.clear();
      for (const fn of batch) fn();
      await flush();
    },
    respond(index, body, url = requests[index].url) { requests[index].resolve({ ok: true, url, text: async () => body }); },
  };
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('all deleted files remain discoverable without any surviving folders', () => {
  const h = harness();
  h.api.set([], [
    { file: 'README.md', source: 'root content' },
    { file: 'removed/deep/code.js', source: '<img src=x onerror=alert(1)>' },
    { file: 'removed/empty.txt', source: '' },
  ]);
  h.api.applyDiffToVisibleFiles();
  const panel = h.document.getElementById('revizorro-deleted-files');
  assert.ok(panel);
  const paths = [...panel.querySelectorAll('.revizorro-deleted-file > summary')].map(el => el.textContent);
  assert.deepEqual(paths, ['README.md', 'removed/deep/code.js', 'removed/empty.txt']);
  const detail = panel.querySelectorAll('.revizorro-deleted-file')[1];
  detail.open = true;
  detail.dispatchEvent(new h.w.Event('toggle'));
  assert.equal(detail.querySelector('pre').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(detail.querySelector('img'), null);
  h.api.applyDiffToVisibleFiles();
  assert.equal(h.document.querySelectorAll('#revizorro-deleted-files').length, 1);
  assert.equal(detail.open, true);
  h.api.removeDiffHighlights();
  assert.equal(h.document.getElementById('revizorro-deleted-files'), null);
  h.api.disconnectObserver();
  h.dom.window.close();
});
test('deleted panel changes with selected history and renders empty sources', () => {
  const h = harness();
  h.api.set([], files('one.txt', ''));
  h.api.applyDiffToVisibleFiles();
  const item = h.document.querySelector('.revizorro-deleted-file');
  assert.ok(item);
  item.open = true;
  item.dispatchEvent(new h.w.Event('toggle'));
  assert.equal(item.querySelector('pre').textContent, '');
  h.api.switchToIteration(files('two.txt', 'second'));
  assert.equal(h.document.querySelector('.revizorro-deleted-file > summary').textContent, 'two.txt');
  assert.equal(h.document.querySelectorAll('.revizorro-deleted-file').length, 1);
  h.api.disconnectObserver();
  h.dom.window.close();
});
test('SPA navigation clears old review before fetch and ignores out-of-order responses', async () => {
  const h = harness();
  h.api.init();
  assert.equal(h.api.data().current[0].source, 'a');
  h.w.history.pushState({}, '', route('b'));
  await h.tick();
  assert.equal(h.api.data(), null);
  assert.equal(h.document.getElementById('revizorro-diff-toggle'), null);
  assert.equal(h.requests.length, 1);
  h.w.history.pushState({}, '', route('c'));
  await h.tick();
  h.respond(1, html('c'));
  await flush();
  assert.equal(h.api.data().current[0].source, 'c');
  h.respond(0, html('b'));
  await flush();
  assert.equal(h.api.data().current[0].source, 'c');
  h.api.disconnectObserver();
  h.dom.window.close();
});
test('SPA starts outside a review, loads on entry, clears on exit, rejects redirected responses', async () => {
  const h = harness('<div class="revisor-review"><div class="tabs-group"></div></div>', origin + '/office/');
  h.api.init();
  h.w.history.pushState({}, '', route('a'));
  await h.tick();
  assert.equal(h.requests.length, 1);
  h.respond(0, html('a'), origin + '/login');
  await flush();
  assert.equal(h.api.data(), null);
  h.w.history.pushState({}, '', route('b'));
  await h.tick();
  h.respond(1, html('b'));
  await flush();
  assert.equal(h.api.data().current[0].source, 'b');
  h.w.history.pushState({}, '', origin + '/office/');
  await h.tick();
  assert.equal(h.api.data(), null);
  assert.equal(h.document.getElementById('revizorro-diff-toggle'), null);
  h.api.disconnectObserver();
  h.dom.window.close();
});
test('history with unknown dates requires explicit selection instead of misleading default', () => {
  const raw = html('a').replace(/"created_at":"[^"]+",/g, '');
  const h = harness(raw);
  h.api.init();
  const select = h.document.getElementById('revizorro-iteration-select');
  assert.equal(select.value, '');
  assert.equal(h.api.data().previous, null);
  select.value = '0';
  select.dispatchEvent(new h.w.Event('change'));
  assert.equal(h.api.data().previous[0].source, 'old');
  h.api.disconnectObserver();
  h.dom.window.close();
});

test('temporary fetch failure retries, and navigation cancels the old request', async () => {
  const h = harness();
  h.api.init();
  h.w.history.pushState({}, '', route('b'));
  await h.tick();
  h.requests[0].reject(new Error('temporary network error'));
  await flush();
  assert.equal(h.api.data(), null);
  h.advance(3000);
  await h.tick();
  assert.equal(h.requests.length, 2);
  h.w.history.pushState({}, '', route('c'));
  await h.tick();
  assert.equal(h.requests[1].options.signal.aborted, true);
  h.respond(2, html('c'));
  await flush();
  assert.equal(h.api.data().current[0].source, 'c');
  h.api.disconnectObserver();
  h.dom.window.close();
});

test('code emptied without a placeholder row still displays removed content once', async () => {
  const h = harness();
  h.document.querySelector('.source-tree').innerHTML = '<div class="source-tree__file"><span class="source-tree__file-name">main.js</span><div class="source-tree__code"></div></div>';
  h.api.set(files('main.js', ''), files('main.js', 'deleted line'));
  h.api.applyDiffToVisibleFiles();
  await h.runTimers();
  h.api.applyDiffToVisibleFiles();
  assert.equal(h.document.querySelectorAll('.revizorro-line-removed').length, 1);
  assert.equal(h.document.querySelector('.revizorro-removed-code').textContent, 'deleted line');
  h.api.disconnectObserver();
  h.dom.window.close();
});

test('deleted files appear when the toolbar mounts after bootstrap and no tree survives', async () => {
  const h = harness(`<script>${bootstrap('a', [], files('gone.txt', 'gone'))}</script>`);
  h.api.init();
  assert.equal(h.document.getElementById('revizorro-diff-toggle'), null);
  const header = h.document.createElement('div');
  header.className = 'tabs-group';
  h.document.body.appendChild(header);
  await h.tick();
  assert.ok(h.document.getElementById('revizorro-diff-toggle'));
  assert.ok(h.document.getElementById('revizorro-deleted-files'));
  h.api.disconnectObserver();
  h.dom.window.close();
});

for (const action of ['disable', 'iteration', 'navigation']) {
  test(`pending diff cannot repaint after ${action}`, async () => {
    const current = Array(3000).fill('new').join('\n');
    const previous = Array(3000).fill('old').join('\n');
    const h = harness(html('a', files('main.js', current), files('main.js', previous)));
    h.document.querySelector('.source-tree').innerHTML = '<div class="source-tree__file"><span class="source-tree__file-name">main.js</span><div class="source-tree__code"><div class="source-tree__code-line"><span class="source-tree__line-number">1</span><code>new</code></div></div></div>';
    try {
      h.api.init();
      assert.equal(h.document.querySelectorAll('.revizorro-line-removed').length, 0,
        'initial rendering must return before the expensive calculation');
      await h.runTimers();
      if (action === 'disable') h.document.getElementById('revizorro-diff-toggle').click();
      if (action === 'iteration') h.api.switchToIteration(files('main.js', current));
      if (action === 'navigation') h.w.history.pushState({}, '', route('b'));
      for (let i = 0; i < 30; i++) await h.runTimers();
      assert.equal(h.document.querySelectorAll('.revizorro-line-removed').length, 0);
      assert.equal(h.document.querySelectorAll('.revizorro-line-added').length, 0);
      if (action === 'iteration') {
        assert.equal(h.document.querySelector('.source-tree__file').dataset.revizorroDiffApplied, 'true');
      }
    } finally {
      h.api.disconnectObserver();
      h.dom.window.close();
    }
  });
}
