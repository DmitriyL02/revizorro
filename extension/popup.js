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
  let url;
  try { url = new URL(tab?.url); } catch (e) { /* unavailable URL */ }
  if (!url || url.protocol !== 'https:' || url.hostname !== expectedHost || !url.pathname.startsWith('/office/revisor-review/')) {
    statusEl.className = 'status status--inactive';
    statusEl.textContent = 'Не на странице ревью';
    infoEl.textContent = 'Откройте страницу ревью на ' + expectedHost;
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'revizorro-status' }, (response) => {
    if (chrome.runtime.lastError || !response?.ready) {
      statusEl.className = 'status status--error';
      statusEl.textContent = 'Diff не готов';
      infoEl.textContent = 'Обновите страницу ревью. Если кнопка Diff не появится, расширение не смогло прочитать данные или найти панель ревью.';
      return;
    }
    if (response.needsSelection) {
      statusEl.className = 'status status--inactive';
      statusEl.textContent = 'Выберите версию для сравнения';
      infoEl.textContent = 'Порядок истории неоднозначен. Включите Diff и выберите предыдущую версию в списке на странице.';
      return;
    }
    statusEl.className = 'status status--ok';
    statusEl.textContent = response.enabled ? 'Подсветка включена' : 'Расширение готово';
    infoEl.textContent = response.hasHistory
      ? 'Кнопка «Diff» на странице включает и выключает подсветку изменений.'
      : 'Первая итерация — нет предыдущей работы для сравнения.';
  });
});
