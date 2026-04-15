// Revizorro Diff — Popup Script

const statusEl = document.getElementById('status');
const infoEl = document.getElementById('info');

// Берём паттерн из manifest.json content_scripts
const matchPattern = chrome.runtime.getManifest().content_scripts?.[0]?.matches?.[0] || '';
// Извлекаем хост из паттерна вида "https://host/*"
const hostMatch = matchPattern.match(/:\/\/([^/]+)/);
const expectedHost = hostMatch ? hostMatch[1] : 'admin.praktikum.yandex-team.ru';

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab || !tab.url || !tab.url.includes(expectedHost + '/office/revisor-review')) {
    statusEl.className = 'status status--inactive';
    statusEl.textContent = 'Не на странице ревью';
    infoEl.textContent = 'Откройте страницу ревью на ' + expectedHost;
    return;
  }

  statusEl.className = 'status status--ok';
  statusEl.textContent = 'Активно на этой странице';
  infoEl.textContent = 'Нажмите кнопку «Diff» на странице для включения подсветки изменений.';
});
