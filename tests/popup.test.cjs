const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../extension/popup.js'), 'utf8');
const reviewURL = 'https://admin.praktikum.yandex-team.ru/office/revisor-review/example';
function popup(url, response, error = false, details = false) {
  const status = {}, info = {};
  const runtime = { getManifest() { return { content_scripts: [{ matches: ['https://admin.praktikum.yandex-team.ru/office/revisor-review/*'] }] }; } };
  vm.runInNewContext(source, { URL,
    document: { getElementById(id) { return id === 'status' ? status : info; } },
    chrome: { runtime, tabs: {
      query(options, cb) { cb([{ id: 1, url }]); },
      sendMessage(id, message, cb) { runtime.lastError = error ? { message: 'no receiver' } : undefined; cb(response); },
    } },
  });
  return details ? status : status.className;
}
test('missing content script is an error, not an active extension', () => {
  assert.equal(popup(reviewURL, undefined, true), 'status status--error');
});
test('failed data extraction is reported', () => {
  assert.equal(popup(reviewURL, { ready: false }), 'status status--error');
});
test('ready content script confirms active status', () => {
  assert.equal(popup(reviewURL, { ready: true, hasHistory: true, enabled: true }), 'status status--ok');
});
test('URL substring on another host cannot report active', () => {
  assert.equal(popup('https://example.org/?next=' + reviewURL, { ready: true }), 'status status--inactive');
});
test('ambiguous history is reported as requiring a version selection', () => {
  const status = popup(reviewURL, { ready: true, hasHistory: true, needsSelection: true, enabled: true }, false, true);
  assert.match(status.textContent, /[Вв]ыберите/);
});
