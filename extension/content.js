// Revizorro Diff — Content Script

(function () {
  'use strict';

  const DIFF_ENABLED_KEY = 'revizorro_diff_enabled';
  const DEBUG = false;
  let diffEnabled = false;
  let pageData = null;
  let diffCache = new Map();
  let observer = null;
  let isApplyingDiff = false;
  let observerDebounceTimer = null;

  let currentFileMap = null;
  let previousFileMap = null;
  let currentBySuffix = null;
  let previousBySuffix = null;
  let badgeMaps = null;

  function buildFileMaps() {
    if (!pageData) return;
    currentFileMap = new Map();
    currentBySuffix = new Map();
    for (const s of pageData.current) {
      currentFileMap.set(s.file, s.source);
      currentBySuffix.set(s.file, s);
    }
    previousFileMap = new Map();
    previousBySuffix = new Map();
    if (pageData.previous) {
      for (const s of pageData.previous) {
        previousFileMap.set(s.file, s.source);
        previousBySuffix.set(s.file, s);
      }
    }
    badgeMaps = null;
  }

  function getBadgeMaps() {
    if (badgeMaps) return badgeMaps;
    const previousMap = new Map();
    const previousByName = new Map();
    if (pageData.previous) {
      for (const s of pageData.previous) {
        previousMap.set(s.file, s.source);
        const name = s.file.split('/').pop();
        if (!previousByName.has(name)) previousByName.set(name, []);
        previousByName.get(name).push(s);
      }
    }
    const currentMap = new Map();
    const currentByName = new Map();
    for (const s of pageData.current) {
      currentMap.set(s.file, s.source);
      const name = s.file.split('/').pop();
      if (!currentByName.has(name)) currentByName.set(name, []);
      currentByName.get(name).push(s);
    }
    badgeMaps = { previousMap, previousByName, currentMap, currentByName };
    return badgeMaps;
  }

  function invalidateCaches() {
    diffCache.clear();
    currentFileMap = null;
    previousFileMap = null;
    currentBySuffix = null;
    previousBySuffix = null;
    badgeMaps = null;
  }

  // === Извлечение данных из страницы ===

  function extractPageData() {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      if (!text.includes('__init__.default(')) continue;

      const marker = '__init__.default({}, ';
      const startIdx = text.indexOf(marker);
      if (startIdx < 0) continue;

      const jsonStart = startIdx + marker.length;
      let endIdx = text.lastIndexOf(', false)');
      if (endIdx < 0) endIdx = text.lastIndexOf(', true)');
      if (endIdx < 0) continue;

      try {
        let jsonStr = text.substring(jsonStart, endIdx);
        jsonStr = jsonStr.replace(/:\s*undefined/g, ': null');
        jsonStr = jsonStr.replace(/,\s*undefined/g, ', null');

        const data = JSON.parse(jsonStr);
        if (!data.apiData) return null;

        const homework = data.apiData.homework;
        const history = data.apiData.history;
        const currentReview = data.apiData.currentReview;

        if (!homework || !homework.data || !homework.data.sources) return null;

        const currentSources = homework.data.sources;
        const iteration = currentReview ? currentReview.iteration : null;

        const filteredHistory = [];
        if (history) {
          for (let i = 0; i < history.length; i++) {
            const h = history[i];
            if (!h.data || !h.data.sources) continue;
            if (h.id === homework.id) {
              if (DEBUG) console.log('[Revizorro Diff] history[' + i + '] совпадает с homework по id, пропускаю');
              continue;
            }
            filteredHistory.push(h);
          }
        }

        const previousSources = filteredHistory.length > 0 ? filteredHistory[0].data.sources : null;
        if (DEBUG && previousSources) {
          console.log('[Revizorro Diff] Предыдущая итерация: files=' + previousSources.length);
        }

        const allIterations = [];
        for (let i = filteredHistory.length - 1; i >= 0; i--) {
          allIterations.push({
            historyEntry: filteredHistory[i],
            label: `Итерация ${filteredHistory.length - i}`,
          });
        }

        return {
          current: currentSources,
          previous: previousSources,
          iteration: iteration,
          allIterations: allIterations,
        };
      } catch (e) {
        if (DEBUG) console.error('[Revizorro Diff] Ошибка парсинга данных:', e);
        return null;
      }
    }
    return null;
  }

  // === Diff-алгоритм (line-based LCS) ===

  function computeLineDiff(oldText, newText) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');

    const n = oldLines.length;
    const m = newLines.length;

    if (n === 0 && m === 0) return [];
    if (n === 0) return newLines.map((l, i) => ({ type: 'added', line: l, newNum: i + 1 }));
    if (m === 0) return oldLines.map((l, i) => ({ type: 'removed', line: l, oldNum: i + 1 }));

    // Для больших файлов — приблизительный diff
    if (n * m > 2_000_000) {
      return simpleDiff(oldLines, newLines);
    }

    // LCS DP — rolling two rows, direction table for backtrack
    let prev = new Uint32Array(m + 1);
    let curr = new Uint32Array(m + 1);
    const dir = new Array(n + 1);
    for (let i = 0; i <= n; i++) {
      dir[i] = new Uint8Array(m + 1);
    }

    for (let i = 1; i <= n; i++) {
      curr.fill(0);
      for (let j = 1; j <= m; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          curr[j] = prev[j - 1] + 1;
          dir[i][j] = 2;
        } else if (prev[j] >= curr[j - 1]) {
          curr[j] = prev[j];
          dir[i][j] = 0;
        } else {
          curr[j] = curr[j - 1];
          dir[i][j] = 1;
        }
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
    }

    const result = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dir[i][j] === 2) {
        result.push({ type: 'context', line: oldLines[i - 1], oldNum: i, newNum: j });
        i--; j--;
      } else if (j > 0 && (i === 0 || dir[i][j] === 1)) {
        result.push({ type: 'added', line: newLines[j - 1], newNum: j });
        j--;
      } else {
        result.push({ type: 'removed', line: oldLines[i - 1], oldNum: i });
        i--;
      }
    }

    return result.reverse();
  }

  function simpleDiff(oldLines, newLines) {
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    const result = [];

    let oi = 0, ni = 0;
    while (oi < oldLines.length || ni < newLines.length) {
      if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
        result.push({ type: 'context', line: oldLines[oi], oldNum: oi + 1, newNum: ni + 1 });
        oi++; ni++;
      } else if (oi < oldLines.length && !newSet.has(oldLines[oi])) {
        result.push({ type: 'removed', line: oldLines[oi], oldNum: oi + 1 });
        oi++;
      } else if (ni < newLines.length && !oldSet.has(newLines[ni])) {
        result.push({ type: 'added', line: newLines[ni], newNum: ni + 1 });
        ni++;
      } else if (oi < oldLines.length) {
        result.push({ type: 'removed', line: oldLines[oi], oldNum: oi + 1 });
        oi++;
      } else {
        result.push({ type: 'added', line: newLines[ni], newNum: ni + 1 });
        ni++;
      }
    }
    return result;
  }

  function getDiffForFile(filename) {
    if (diffCache.has(filename)) return diffCache.get(filename);
    if (!currentFileMap || !previousFileMap) return null;

    const currentSource = currentFileMap.get(filename);
    const previousSource = previousFileMap.get(filename);

    if (currentSource === undefined && previousSource === undefined) return null;

    const diff = computeLineDiff(previousSource || '', currentSource || '');
    diffCache.set(filename, diff);
    return diff;
  }

  // === UI — Toggle + селектор итерации ===

  function switchToIteration(sources) {
    removeDiffHighlights();
    pageData.previous = sources;
    invalidateCaches();
    buildFileMaps();
    if (diffEnabled) {
      applyDiffToVisibleFiles();
    }
  }

  function createToggleButton() {
    if (document.getElementById('revizorro-diff-toggle')) return;

    const container = document.createElement('div');
    container.id = 'revizorro-diff-container';
    container.className = 'revizorro-diff-container';

    const label = document.createElement('span');
    label.className = 'revizorro-diff-label';
    label.textContent = 'Diff';

    const toggle = document.createElement('button');
    toggle.id = 'revizorro-diff-toggle';
    toggle.className = 'revizorro-toggle';
    toggle.title = 'Показать/скрыть diff между итерациями';

    const select = document.createElement('select');
    select.id = 'revizorro-iteration-select';
    select.className = 'revizorro-select';
    select.title = 'Сравнить с итерацией...';

    if (pageData && pageData.allIterations) {
      const iterations = pageData.allIterations;
      for (let i = 0; i < iterations.length; i++) {
        const iter = iterations[i];
        const option = document.createElement('option');
        option.value = i;
        option.textContent = 'vs ' + iter.label;
        if (i === iterations.length - 1) {
          option.selected = true;
        }
        select.appendChild(option);
      }
    }

    select.addEventListener('change', () => {
      const idx = parseInt(select.value, 10);
      const iter = pageData.allIterations[idx];
      if (iter) {
        switchToIteration(iter.historyEntry.data.sources);
      }
    });

    const selectWrapper = document.createElement('div');
    selectWrapper.className = 'revizorro-select-wrapper';
    selectWrapper.appendChild(select);

    toggle.addEventListener('click', () => {
      diffEnabled = !diffEnabled;
      container.classList.toggle('revizorro-diff-container--active', diffEnabled);
      toggle.classList.toggle('revizorro-toggle--on', diffEnabled);
      selectWrapper.classList.toggle('revizorro-select-wrapper--visible', diffEnabled);
      try { chrome.storage.local.set({ [DIFF_ENABLED_KEY]: diffEnabled }); } catch (e) { /* context invalidated */ }
      if (diffEnabled) {
        setupObserver();
        applyDiffToVisibleFiles();
      } else {
        disconnectObserver();
        removeDiffHighlights();
      }
    });

    container.appendChild(label);
    container.appendChild(toggle);
    container.appendChild(selectWrapper);

    const insertButton = () => {
      const tabsGroup = document.querySelector('.tabs-group-default, .tabs-group');
      if (tabsGroup) {
        tabsGroup.appendChild(container);
        return true;
      }
      const reviewHeader = document.querySelector('.review-header');
      if (reviewHeader) {
        reviewHeader.appendChild(container);
        return true;
      }
      return false;
    };

    if (!insertButton()) {
      let attempts = 0;
      const maxAttempts = 20;
      const waitForTabs = setInterval(() => {
        if (insertButton() || ++attempts >= maxAttempts) {
          clearInterval(waitForTabs);
        }
      }, 500);
    }

    try {
      chrome.storage.local.get(DIFF_ENABLED_KEY, (result) => {
        if (chrome.runtime.lastError) return;
        if (result[DIFF_ENABLED_KEY]) {
          diffEnabled = true;
          container.classList.add('revizorro-diff-container--active');
          toggle.classList.add('revizorro-toggle--on');
          selectWrapper.classList.add('revizorro-select-wrapper--visible');
          setupObserver();
          applyDiffToVisibleFiles();
        }
      });
    } catch (e) { /* context invalidated */ }
  }

  // === Подсветка diff в DOM ===

  function getFullFilePath(fileElement) {
    const parts = [];
    const nameEl = fileElement.querySelector('.source-tree__file-name');
    if (!nameEl) return null;
    const fileName = nameEl.textContent.trim();

    let el = fileElement.parentElement;
    while (el) {
      const folderName = el.querySelector(':scope > .source-tree__folder-title .source-tree__folder-name');
      if (folderName) {
        const name = folderName.textContent.trim();
        if (!name.startsWith('Как сдавать')) {
          parts.unshift(name);
        }
      }
      el = el.parentElement;
      if (el && el.classList && el.classList.contains('source-tree')) break;
    }
    parts.push(fileName);
    return parts.join('/');
  }

  function findMatchingSourceFile(partialPath) {
    if (!currentFileMap) return null;
    if (currentFileMap.has(partialPath)) return partialPath;
    if (previousFileMap && previousFileMap.has(partialPath)) return partialPath;
    for (const [path] of currentFileMap) {
      if (path.endsWith('/' + partialPath)) return path;
    }
    if (previousFileMap) {
      for (const [path] of previousFileMap) {
        if (path.endsWith('/' + partialPath)) return path;
      }
    }
    return null;
  }

  function applyDiffToVisibleFiles() {
    if (!diffEnabled || !pageData || !pageData.previous) return;
    if (isApplyingDiff) return;
    isApplyingDiff = true;
    try {
      _applyDiffToVisibleFilesInner();
    } finally {
      isApplyingDiff = false;
    }
  }

  function _applyDiffToVisibleFilesInner() {
    const fileElements = document.querySelectorAll('.source-tree__file');
    if (DEBUG) console.log('[Revizorro Diff] Найдено файлов в DOM:', fileElements.length);

    for (const fileEl of fileElements) {
      const codeArea = fileEl.querySelector('.source-tree__code');
      if (!codeArea) continue;

      const codeLines = codeArea.querySelectorAll('.source-tree__code-line:not(.revizorro-injected)');
      if (codeLines.length === 0) continue;

      if (fileEl.dataset.revizorroDiffApplied === 'true') continue;

      const partialPath = getFullFilePath(fileEl);
      if (DEBUG) console.log('[Revizorro Diff] Файл в DOM:', partialPath);
      if (!partialPath) continue;

      const fullPath = findMatchingSourceFile(partialPath);
      if (DEBUG) console.log('[Revizorro Diff] Совпадение в данных:', fullPath);
      if (!fullPath) continue;

      const diff = getDiffForFile(fullPath);
      if (!diff) continue;

      applyDiffToCodeBlock(codeArea, codeLines, diff);
      fileEl.dataset.revizorroDiffApplied = 'true';
    }

    applyFileBadges();
  }

  function applyDiffToCodeBlock(codeArea, codeLines, diff) {
    if (DEBUG) {
      const addedCount = diff.filter(d => d.type === 'added').length;
      const removedCount = diff.filter(d => d.type === 'removed').length;
      console.log('[Revizorro Diff] applyDiffToCodeBlock:', { codeLines: codeLines.length, diffEntries: diff.length, added: addedCount, removed: removedCount });
    }

    const newLineMap = new Map();
    const removedBeforeLine = new Map();

    let lastNewNum = 0;
    const removedBuffer = [];

    for (const entry of diff) {
      if (entry.type === 'removed') {
        removedBuffer.push(entry);
      } else {
        if (entry.newNum) {
          if (removedBuffer.length > 0) {
            removedBeforeLine.set(entry.newNum, [...removedBuffer]);
            removedBuffer.length = 0;
          }
          if (entry.type === 'added') {
            newLineMap.set(entry.newNum, entry);
          }
          lastNewNum = entry.newNum;
        }
      }
    }
    if (removedBuffer.length > 0) {
      removedBeforeLine.set(lastNewNum + 1, [...removedBuffer]);
    }

    for (const codeLine of codeLines) {
      const lineNumEl = codeLine.querySelector('.source-tree__line-number');
      if (!lineNumEl) continue;

      const lineNum = parseInt(lineNumEl.textContent.trim(), 10);
      if (isNaN(lineNum)) continue;

      const removedEntries = removedBeforeLine.get(lineNum);
      if (removedEntries) {
        for (const removed of removedEntries) {
          const removedEl = createRemovedLineElement(removed);
          codeLine.parentElement.insertBefore(removedEl, codeLine);
        }
      }

      if (newLineMap.has(lineNum)) {
        codeLine.classList.add('revizorro-line-added');
      }
    }

    const afterLast = removedBeforeLine.get(lastNewNum + 1);
    if (afterLast && codeLines.length > 0) {
      const lastLine = codeLines[codeLines.length - 1];
      for (const removed of afterLast) {
        const removedEl = createRemovedLineElement(removed);
        lastLine.parentElement.appendChild(removedEl);
      }
    }
  }

  function createRemovedLineElement(entry) {
    const el = document.createElement('div');
    el.className = 'source-tree__code-line revizorro-line-removed revizorro-injected';

    const lineNumDiv = document.createElement('div');
    lineNumDiv.className = 'source-tree__line-number revizorro-removed-line-num';
    lineNumDiv.textContent = entry.oldNum || '';

    const codeBlock = document.createElement('code');
    codeBlock.className = 'source-tree__code-block revizorro-removed-code';
    codeBlock.textContent = entry.line;

    el.appendChild(lineNumDiv);
    el.appendChild(codeBlock);
    return el;
  }

  // === Бейджи на папках и файлах ===

  function computeFolderStats() {
    const { currentMap, previousMap } = getBadgeMaps();
    const stats = new Map();

    const bump = (filePath, type) => {
      const parts = filePath.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join('/');
        let s = stats.get(folder);
        if (!s) { s = { added: 0, modified: 0, removed: 0, deletedFiles: [] }; stats.set(folder, s); }
        s[type]++;
      }
    };

    for (const [path, source] of currentMap) {
      const prev = previousMap.get(path);
      if (prev === undefined) bump(path, 'added');
      else if (prev !== source) bump(path, 'modified');
    }
    for (const [path] of previousMap) {
      if (!currentMap.has(path)) {
        bump(path, 'removed');
        // Добавляем имя файла только в непосредственную родительскую папку
        const lastSlash = path.lastIndexOf('/');
        if (lastSlash >= 0) {
          const parentFolder = path.substring(0, lastSlash);
          const s = stats.get(parentFolder);
          if (s) s.deletedFiles.push(path.substring(lastSlash + 1));
        }
      }
    }

    return stats;
  }

  function getFolderPath(titleEl) {
    const parts = [];
    const ownName = titleEl.querySelector('.source-tree__folder-name');
    if (!ownName) return null;
    const name = ownName.textContent.trim();
    if (name.startsWith('Как сдавать')) return null;
    parts.push(name);

    let el = titleEl.parentElement;
    while (el) {
      el = el.parentElement;
      if (!el) break;
      if (el.classList && el.classList.contains('source-tree')) break;
      const parentTitle = el.querySelector(':scope > .source-tree__folder-title .source-tree__folder-name');
      if (parentTitle) {
        const pName = parentTitle.textContent.trim();
        if (!pName.startsWith('Как сдавать')) {
          parts.unshift(pName);
        }
      }
    }
    return parts.join('/');
  }

  function applyFolderBadges() {
    if (!pageData || !pageData.previous) return;
    const stats = computeFolderStats();
    if (stats.size === 0) return;

    document.querySelectorAll('.revizorro-deleted-summary').forEach(el => el.remove());

    const titleElements = document.querySelectorAll('.source-tree__folder-title');
    for (const titleEl of titleElements) {
      const folderPath = getFolderPath(titleEl);
      if (!folderPath) continue;

      let s = stats.get(folderPath);
      if (!s) {
        for (const [key, val] of stats) {
          if (key.endsWith('/' + folderPath) || key === folderPath) { s = val; break; }
        }
      }
      if (!s || (s.added === 0 && s.modified === 0 && s.removed === 0)) continue;

      // Бейдж — создаём один раз
      if (!titleEl.querySelector('.revizorro-folder-stats')) {
        const badge = document.createElement('span');
        badge.className = 'revizorro-folder-stats revizorro-injected';

        if (s.added > 0) {
          const sp = document.createElement('span');
          sp.className = 'revizorro-stat-added';
          sp.textContent = '+' + s.added;
          badge.appendChild(sp);
        }
        if (s.modified > 0) {
          if (badge.childNodes.length > 0) badge.appendChild(document.createTextNode(' '));
          const sp = document.createElement('span');
          sp.className = 'revizorro-stat-modified';
          sp.textContent = '~' + s.modified;
          badge.appendChild(sp);
        }
        if (s.removed > 0) {
          if (badge.childNodes.length > 0) badge.appendChild(document.createTextNode(' '));
          const sp = document.createElement('span');
          sp.className = 'revizorro-stat-removed';
          sp.textContent = '-' + s.removed;
          badge.appendChild(sp);
        }

        const folderNameEl = titleEl.querySelector('.source-tree__folder-name');
        if (folderNameEl) {
          folderNameEl.insertAdjacentElement('afterend', badge);
        } else {
          titleEl.appendChild(badge);
        }
      }

      // Виджет удалённых файлов — показываем когда папка раскрыта
      if (s.deletedFiles && s.deletedFiles.length > 0) {
        const folderContainer = titleEl.parentElement;
        if (folderContainer && !folderContainer.querySelector('.revizorro-deleted-summary')) {
          const firstFile = folderContainer.querySelector('.source-tree__file');
          if (firstFile) {
            const widget = createDeletedWidget(s.deletedFiles);
            firstFile.parentElement.insertBefore(widget, firstFile);
          }
        }
      }
    }
  }

  function createDeletedWidget(fileNames) {
    const container = document.createElement('div');
    container.className = 'revizorro-deleted-summary revizorro-injected';

    const list = document.createElement('div');
    list.className = 'revizorro-deleted-list';
    for (const name of fileNames) {
      const item = document.createElement('div');
      item.className = 'revizorro-deleted-item';
      item.textContent = name;
      list.appendChild(item);
    }

    const header = document.createElement('div');
    header.className = 'revizorro-deleted-header';
    header.textContent = '\u2212 ' + fileNames.length + ' ' + pluralFiles(fileNames.length) + ' удалено';
    header.addEventListener('click', () => {
      list.classList.toggle('revizorro-deleted-list--open');
      header.classList.toggle('revizorro-deleted-header--open');
    });

    container.appendChild(header);
    container.appendChild(list);
    return container;
  }

  function applyFileBadges() {
    if (!pageData || !pageData.previous) return;

    const { previousMap, previousByName, currentMap, currentByName } = getBadgeMaps();

    const fileElements = document.querySelectorAll('.source-tree__file');
    let badgeCount = 0;

    for (const fileEl of fileElements) {
      if (fileEl.querySelector('.revizorro-badge')) continue;

      const nameEl = fileEl.querySelector('.source-tree__file-name');
      if (!nameEl) continue;
      const fileName = nameEl.textContent.trim();

      let fullPath = null;
      const partialPath = getFullFilePath(fileEl);
      if (partialPath) {
        fullPath = findMatchingSourceFile(partialPath);
      }

      if (!fullPath) {
        const currentMatches = currentByName.get(fileName) || [];
        const prevMatches = previousByName.get(fileName) || [];
        if (currentMatches.length === 1) {
          fullPath = currentMatches[0].file;
        } else if (prevMatches.length === 1) {
          fullPath = prevMatches[0].file;
        }
      }

      if (!fullPath) continue;

      const currentSource = currentMap.get(fullPath);
      const previousSource = previousMap.get(fullPath);

      let badgeType = null;
      if (currentSource !== undefined && previousSource === undefined) {
        badgeType = 'added';
      } else if (currentSource === undefined && previousSource !== undefined) {
        badgeType = 'removed';
      } else if (currentSource !== undefined && previousSource !== undefined && currentSource !== previousSource) {
        badgeType = 'modified';
      }

      if (badgeType) {
        const badge = document.createElement('span');
        badge.className = 'revizorro-badge revizorro-badge--' + badgeType;
        badge.textContent = badgeType === 'added' ? 'новый' : badgeType === 'removed' ? 'удалён' : 'изменён';
        nameEl.insertAdjacentElement('afterend', badge);
        badgeCount++;
      }
    }

    if (DEBUG && badgeCount > 0) {
      console.log('[Revizorro Diff] Бейджи добавлены: ' + badgeCount);
    }

    applyFolderBadges();
  }

  function pluralFiles(n) {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'файл';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'файла';
    return 'файлов';
  }


  function removeDiffHighlights() {
    isApplyingDiff = true;
    try {
      document.querySelectorAll('.revizorro-line-added').forEach(el => {
        el.classList.remove('revizorro-line-added');
      });
      document.querySelectorAll('.revizorro-injected').forEach(el => {
        el.remove();
      });
      document.querySelectorAll('.revizorro-badge').forEach(el => {
        el.remove();
      });
      document.querySelectorAll('[data-revizorro-diff-applied]').forEach(el => {
        delete el.dataset.revizorroDiffApplied;
      });
    } finally {
      isApplyingDiff = false;
    }
  }

  // === MutationObserver для SPA ===

  function disconnectObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    clearTimeout(observerDebounceTimer);
  }

  function setupObserver() {
    if (observer) observer.disconnect();

    const mount = document.getElementById('mount') || document.body;

    observer = new MutationObserver((mutations) => {
      if (!diffEnabled || isApplyingDiff) return;

      let hasNewCode = false;
      let hasNewFiles = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('revizorro-injected') ||
              node.classList?.contains('revizorro-badge')) continue;
          if (node.classList?.contains('source-tree__code') ||
              node.classList?.contains('source-tree__source') ||
              node.querySelector?.('.source-tree__code')) {
            hasNewCode = true;
            const fileEl = node.closest?.('.source-tree__file');
            if (fileEl) {
              delete fileEl.dataset.revizorroDiffApplied;
            }
          }
          if (node.classList?.contains('source-tree__file') ||
              node.classList?.contains('source-tree__dir') ||
              node.querySelector?.('.source-tree__file')) {
            hasNewFiles = true;
          }
        }
        for (const node of mutation.removedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('source-tree__code') ||
              node.classList?.contains('source-tree__source')) {
            const fileEl = mutation.target.closest?.('.source-tree__file');
            if (fileEl) {
              delete fileEl.dataset.revizorroDiffApplied;
            }
          }
          if (node.classList?.contains('source-tree__file') ||
              node.classList?.contains('source-tree__dir') ||
              node.querySelector?.('.source-tree__file')) {
            hasNewFiles = true;
          }
        }
      }

      if (hasNewCode || hasNewFiles) {
        clearTimeout(observerDebounceTimer);
        observerDebounceTimer = setTimeout(applyDiffToVisibleFiles, 100);
      }
    });

    observer.observe(mount, { childList: true, subtree: true });
  }

  // === Инициализация ===

  function init() {
    pageData = extractPageData();

    if (!pageData) {
      if (DEBUG) console.log('[Revizorro Diff] Данные ревью не найдены на странице');
      return;
    }

    if (DEBUG) {
      if (!pageData.previous) {
        console.log('[Revizorro Diff] Нет предыдущей итерации для сравнения');
      }
      console.log('[Revizorro Diff] Загружено: ' + pageData.current.length + ' файлов, ' + pageData.allIterations.length + ' итераций');
    }

    buildFileMaps();
    createToggleButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
