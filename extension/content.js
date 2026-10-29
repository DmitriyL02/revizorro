// Revizorro Diff — Content Script

(function () {
  'use strict';

  const DIFF_ENABLED_KEY = 'revizorro_diff_enabled';
  const DEBUG = false;
  let diffEnabled = false;
  let pageData = null;
  let diffCache = new Map();
  const pendingDiffs = new Map();
  let diffRevision = 0;
  let observer = null;
  let isApplyingDiff = false;
  let observerDebounceTimer = null;
  let activeReviewUrl;
  let navigationRevision = 0;
  let navigationRequest = null;
  let loadingReview = false;
  let retryAt = Infinity;
  let retryDelay = 2000;
  let toggleMountTimer = null;

  let currentFileMap = null;
  let previousFileMap = null;
  let currentByName = null;
  let previousByName = null;
  let suffixIndex = null;

  try {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'revizorro-status') return;
      respond({
        ready: activeReviewUrl === currentReviewUrl() && !!pageData && !!document.getElementById('revizorro-diff-toggle'),
        hasHistory: !!pageData?.allIterations?.length,
        needsSelection: !!pageData?.allIterations?.length && !pageData.previous,
        enabled: diffEnabled,
      });
    });
  } catch (e) { /* context invalidated */ }

  function alignPreviousRoot(current, previous) {
    const singleRoot = sources => {
      if (!sources.length) return null;
      const root = sources[0].file.split('/')[0];
      return root && sources.every(s => s.file.startsWith(root + '/')) ? root : null;
    };
    const currentRoot = singleRoot(current);
    const previousRoot = singleRoot(previous);
    if (!currentRoot || !previousRoot || currentRoot === previousRoot) return previous;
    const relativePaths = new Set(current.map(s => s.file.slice(currentRoot.length + 1)));
    if (!previous.some(s => relativePaths.has(s.file.slice(previousRoot.length + 1)))) return previous;
    // Only the archive wrapper changes; nested paths retain their identity.
    return previous.map(s => ({ ...s, file: currentRoot + s.file.slice(previousRoot.length) }));
  }

  function buildFileMaps() {
    if (!pageData) return;
    currentFileMap = new Map();
    currentByName = new Map();
    suffixIndex = new Map();
    for (const s of pageData.current) {
      currentFileMap.set(s.file, s.source);
      const name = s.file.split('/').pop();
      if (!currentByName.has(name)) currentByName.set(name, []);
      currentByName.get(name).push(s);
      const idx = s.file.lastIndexOf('/');
      if (idx >= 0) {
        const suffix = s.file.substring(idx + 1);
        if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, []);
        suffixIndex.get(suffix).push(s.file);
      }
    }
    previousFileMap = new Map();
    previousByName = new Map();
    if (pageData.previous) {
      for (const s of alignPreviousRoot(pageData.current, pageData.previous)) {
        previousFileMap.set(s.file, s.source);
        const name = s.file.split('/').pop();
        if (!previousByName.has(name)) previousByName.set(name, []);
        previousByName.get(name).push(s);
        const idx = s.file.lastIndexOf('/');
        if (idx >= 0) {
          const suffix = s.file.substring(idx + 1);
          if (!suffixIndex.has(suffix)) suffixIndex.set(suffix, []);
          suffixIndex.get(suffix).push(s.file);
        }
      }
    }
  }

  function cancelPendingDiffs() {
    diffRevision++;
    pendingDiffs.clear();
  }

  function invalidateCaches() {
    cancelPendingDiffs();
    diffCache.clear();
    currentFileMap = null;
    previousFileMap = null;
    currentByName = null;
    previousByName = null;
    suffixIndex = null;
  }

  // === Извлечение данных из страницы ===

  function readBootstrapObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        // Bootstrap is JSON with undefined values. Preserve quoted source code;
        // never evaluate JavaScript from the page.
        const json = text.slice(start, i + 1).replace(
          /"(?:\\.|[^"\\])*"|\bundefined\b/g,
          token => token === 'undefined' ? 'null' : token
        );
        return JSON.parse(json);
      }
    }
    throw new Error('Incomplete review bootstrap');
  }

  function extractPageData(root = document) {
    const scripts = root.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent;
      const modern = /\bwindow\.wirthAdminBootstrap\s*=\s*(?=\{)/.exec(text);
      const marker = modern || /\b__init__\.default\s*\(\s*\{\s*\}\s*,\s*(?=\{)/.exec(text);
      if (!marker) continue;

      try {
        const bootstrap = readBootstrapObject(text, marker.index + marker[0].length);
        const data = modern ? bootstrap.data : bootstrap;
        if (!data || !data.apiData) continue;

        const homework = data.apiData.homework;
        const history = data.apiData.history;
        const currentReview = data.apiData.currentReview;

        if (!Array.isArray(homework?.data?.sources) || !homework.data.sources.every(s =>
          s && typeof s.file === 'string' && typeof s.source === 'string')) continue;

        const currentSources = homework.data.sources;
        const iteration = currentReview ? currentReview.iteration : null;

        const { previous, allIterations } = globalThis.RevizorroReviewHistory.selectHistory(homework, history, currentReview);

        return {
          current: currentSources,
          previous,
          iteration: iteration,
          allIterations: allIterations,
        };
      } catch (e) {
        if (DEBUG) console.error('[Revizorro Diff] Ошибка парсинга данных:', e);
      }
    }
    return null;
  }

  const { computeLineDiffAsync } = globalThis.RevizorroLineDiff;

  async function getDiffForFile(filename) {
    if (diffCache.has(filename)) return diffCache.get(filename);
    if (pendingDiffs.has(filename)) return pendingDiffs.get(filename);
    if (!currentFileMap || !previousFileMap) return null;

    const currentSource = currentFileMap.get(filename);
    const previousSource = previousFileMap.get(filename);
    if (currentSource === undefined && previousSource === undefined) return null;

    const revision = diffRevision;
    const isCancelled = () => revision !== diffRevision ||
      (activeReviewUrl !== undefined && activeReviewUrl !== currentReviewUrl());
    const pending = computeLineDiffAsync(previousSource || '', currentSource || '', { isCancelled });
    pendingDiffs.set(filename, pending);
    try {
      const diff = await pending;
      if (!diff || isCancelled()) return null;
      diffCache.set(filename, diff);
      return diff;
    } finally {
      if (pendingDiffs.get(filename) === pending) pendingDiffs.delete(filename);
    }
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
    if (document.getElementById('revizorro-diff-toggle') || toggleMountTimer) return;
    const review = pageData;

    const container = document.createElement('div');
    container.id = 'revizorro-diff-container';
    container.className = 'revizorro-diff-container';

    const label = document.createElement('span');
    label.className = 'revizorro-diff-label';
    label.textContent = 'Diff';

    const hasHistory = !!(pageData && pageData.allIterations && pageData.allIterations.length > 0);

    const toggle = document.createElement('button');
    toggle.id = 'revizorro-diff-toggle';
    toggle.className = 'revizorro-toggle';
    toggle.title = hasHistory
      ? 'Показать/скрыть diff между итерациями'
      : 'Первая итерация — нечего сравнивать';
    if (!hasHistory) {
      toggle.disabled = true;
      toggle.classList.add('revizorro-toggle--disabled');
    }

    const select = document.createElement('select');
    select.id = 'revizorro-iteration-select';
    select.className = 'revizorro-select';
    select.title = 'Сравнить с итерацией...';

    if (hasHistory) {
      const iterations = pageData.allIterations;
      if (!pageData.previous) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Выберите версию для сравнения';
        placeholder.disabled = true;
        placeholder.selected = true;
        select.appendChild(placeholder);
      }
      for (let i = 0; i < iterations.length; i++) {
        const iter = iterations[i];
        const option = document.createElement('option');
        option.value = i;
        option.textContent = 'vs ' + iter.label;
        option.title = iter.title || iter.label;
        if (iter.historyEntry.data.sources === pageData.previous) {
          option.selected = true;
        }
        select.appendChild(option);
      }
    }

    const firstIterHint = document.createElement('span');
    firstIterHint.className = 'revizorro-first-iter-hint';
    firstIterHint.textContent = 'первая итерация';

    select.addEventListener('change', () => {
      if (pageData !== review) return;
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
      if (!hasHistory || pageData !== review) return;
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
    if (hasHistory) {
      container.appendChild(selectWrapper);
    } else {
      container.appendChild(firstIterHint);
    }

    const insertButton = () => {
      if (pageData !== review) return true;
      const tabsGroup = document.querySelector('.tabs-group-default, .tabs-group');
      if (tabsGroup) {
        tabsGroup.appendChild(container);
        applyDiffToVisibleFiles();
        return true;
      }
      const reviewHeader = document.querySelector('.review-header');
      if (reviewHeader) {
        reviewHeader.appendChild(container);
        applyDiffToVisibleFiles();
        return true;
      }
      return false;
    };

    if (!insertButton()) {
      let attempts = 0;
      const maxAttempts = 20;
      toggleMountTimer = setInterval(() => {
        if (insertButton() || ++attempts >= maxAttempts) {
          clearInterval(toggleMountTimer);
          toggleMountTimer = null;
        }
      }, 500);
    }

    if (!hasHistory) return;

    try {
      chrome.storage.local.get(DIFF_ENABLED_KEY, (result) => {
        if (chrome.runtime.lastError || pageData !== review) return;
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
    if (suffixIndex) {
      const tail = partialPath.split('/').pop();
      const candidates = suffixIndex.get(tail);
      if (candidates) {
        const matches = [...new Set(candidates.filter(path => path.endsWith('/' + partialPath)))];
        if (matches.length === 1) return matches[0];
      }
    }
    return null;
  }

  function applyDiffToVisibleFiles() {
    if (activeReviewUrl !== undefined && activeReviewUrl !== currentReviewUrl()) {
      syncReviewLocation();
      return;
    }
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

      if (fileEl.dataset.revizorroDiffApplied === 'true') continue;

      const partialPath = getFullFilePath(fileEl);
      if (DEBUG) console.log('[Revizorro Diff] Файл в DOM:', partialPath);
      if (!partialPath) continue;

      const fullPath = findMatchingSourceFile(partialPath);
      if (DEBUG) console.log('[Revizorro Diff] Совпадение в данных:', fullPath);
      if (!fullPath) continue;

      if (codeLines.length === 0 && currentFileMap.get(fullPath)) continue;
      if (!diffCache.has(fullPath)) {
        if (!pendingDiffs.has(fullPath)) {
          getDiffForFile(fullPath).then(diff => {
            if (diff) applyDiffToVisibleFiles();
          }).catch(error => {
            if (DEBUG) console.warn('[Revizorro Diff] Ошибка расчёта:', error);
          });
        }
        continue;
      }
      const diff = diffCache.get(fullPath);

      codeArea.querySelectorAll('.revizorro-injected').forEach(el => el.remove());
      codeArea.querySelectorAll('.revizorro-line-added').forEach(el => el.classList.remove('revizorro-line-added'));
      applyDiffToCodeBlock(codeArea, codeLines, diff);
      fileEl.dataset.revizorroDiffApplied = 'true';
    }

    applyFileBadges();
    applyDeletedFiles();
  }

  function applyDiffToCodeBlock(codeArea, codeLines, diff) {
    if (codeLines.length === 0) {
      for (const entry of diff) {
        if (entry.type === 'removed') codeArea.appendChild(createRemovedLineElement(entry));
      }
      return;
    }
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
        removedBeforeLine.delete(lineNum);
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
    if (!currentFileMap || !previousFileMap) return new Map();
    const stats = new Map();

    const bump = (filePath, type) => {
      const parts = filePath.split('/');
      let folder = '';
      for (let depth = 0; depth < parts.length - 1; depth++) {
        folder = depth === 0 ? parts[0] : folder + '/' + parts[depth];
        let s = stats.get(folder);
        if (!s) { s = { added: 0, modified: 0, removed: 0, deletedFiles: [] }; stats.set(folder, s); }
        s[type]++;
      }
    };

    for (const [path, source] of currentFileMap) {
      const prev = previousFileMap.get(path);
      if (prev === undefined) bump(path, 'added');
      else if (prev !== source) bump(path, 'modified');
    }
    for (const [path] of previousFileMap) {
      if (!currentFileMap.has(path)) {
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

    const titleElements = document.querySelectorAll('.source-tree__folder-title');
    for (const titleEl of titleElements) {
      const folderPath = getFolderPath(titleEl);
      if (!folderPath) continue;

      let s = stats.get(folderPath);
      if (!s) {
        const matches = [...stats].filter(([key]) => key.endsWith('/' + folderPath));
        if (matches.length === 1) s = matches[0][1];
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

    }
  }

  function applyDeletedFiles() {
    if (document.getElementById('revizorro-deleted-files')) return;
    const deleted = [...previousFileMap].filter(([path]) => !currentFileMap.has(path))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (deleted.length === 0) return;
    const anchor = document.querySelector('.source-tree') ||
      document.getElementById('revizorro-diff-container')?.parentElement;
    if (!anchor) return;
    const panel = document.createElement('details');
    panel.id = 'revizorro-deleted-files';
    panel.className = 'revizorro-deleted-summary revizorro-injected';
    const heading = document.createElement('summary');
    heading.textContent = `Удалённые файлы (${deleted.length}) — относительно выбранной версии`;
    panel.appendChild(heading);
    for (const [path, source] of deleted) {
      const item = document.createElement('details');
      item.className = 'revizorro-deleted-file';
      const title = document.createElement('summary');
      title.textContent = path;
      item.appendChild(title);
      item.addEventListener('toggle', () => {
        if (!item.open || item.querySelector('pre')) return;
        const code = document.createElement('pre');
        code.className = 'revizorro-deleted-source';
        code.textContent = source;
        item.appendChild(code);
      });
      panel.appendChild(item);
    }
    anchor.insertAdjacentElement('beforebegin', panel);
  }

  function applyFileBadges() {
    if (!pageData || !pageData.previous) return;

    if (!currentFileMap || !previousFileMap) return;

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
        const currentMatches = (currentByName && currentByName.get(fileName)) || [];
        const prevMatches = (previousByName && previousByName.get(fileName)) || [];
        const paths = [...new Set([...currentMatches, ...prevMatches].map(s => s.file))];
        if (paths.length === 1) fullPath = paths[0];
      }

      if (!fullPath) continue;

      const currentSource = currentFileMap.get(fullPath);
      const previousSource = previousFileMap.get(fullPath);

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
    cancelPendingDiffs();
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
      if (activeReviewUrl !== undefined && activeReviewUrl !== currentReviewUrl()) {
        syncReviewLocation();
        return;
      }
      if (!diffEnabled || isApplyingDiff) return;

      const injected = '.revizorro-injected, .revizorro-badge';
      const code = '.source-tree__code, .source-tree__source, .source-tree__code-line';
      const tree = code + ', .source-tree__file, .source-tree__dir';
      let changed = false;
      for (const mutation of mutations) {
        const target = mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target;
        if (target?.closest?.(injected)) continue;
        const nodes = [...mutation.addedNodes, ...mutation.removedNodes].filter(node =>
          !node.matches?.(injected));
        if (mutation.type !== 'characterData' && nodes.length === 0) continue;

        if (target?.closest?.(code)) {
          const file = target.closest('.source-tree__file');
          if (file) delete file.dataset.revizorroDiffApplied;
          changed = true;
        }
        for (const node of nodes) {
          if (node.matches?.(tree) || node.querySelector?.(tree)) {
            const file = node.closest?.('.source-tree__file') || target?.closest?.('.source-tree__file');
            if (file) delete file.dataset.revizorroDiffApplied;
            changed = true;
          }
        }
      }
      if (changed) {
        clearTimeout(observerDebounceTimer);
        observerDebounceTimer = setTimeout(applyDiffToVisibleFiles, 100);
      }
    });

    observer.observe(mount, { childList: true, subtree: true, characterData: true });
  }

  // === Инициализация ===

  function currentReviewUrl() {
    return location.pathname.startsWith('/office/revisor-review/')
      ? location.origin + location.pathname + location.search : null;
  }

  function installReview(data) {
    pageData = data;
    retryAt = Infinity;
    retryDelay = 2000;
    buildFileMaps();
    createToggleButton();
  }

  async function loadReview(url, revision) {
    loadingReview = true;
    const controller = new AbortController();
    navigationRequest = controller;
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok || response.url !== url) throw new Error('Review request failed or redirected');
      const html = await response.text();
      if (revision !== navigationRevision || currentReviewUrl() !== url) return;
      const data = extractPageData(new DOMParser().parseFromString(html, 'text/html'));
      if (!data) throw new Error('Review data unavailable');
      installReview(data);
    } catch (error) {
      if (revision === navigationRevision && error.name !== 'AbortError') {
        retryAt = Date.now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, 60000);
        if (DEBUG) console.warn('[Revizorro Diff] Не удалось обновить ревью:', error);
      }
    } finally {
      if (revision === navigationRevision) {
        loadingReview = false;
        navigationRequest = null;
      }
    }
  }

  function syncReviewLocation(useInitialDocument = false) {
    const url = currentReviewUrl();
    if (url === activeReviewUrl) {
      if (pageData) createToggleButton();
      else if (url && !loadingReview && Date.now() >= retryAt) loadReview(url, navigationRevision);
      return;
    }
    navigationRevision++;
    navigationRequest?.abort();
    navigationRequest = null;
    loadingReview = false;
    clearInterval(toggleMountTimer);
    toggleMountTimer = null;
    disconnectObserver();
    removeDiffHighlights();
    document.getElementById('revizorro-diff-container')?.remove();
    pageData = null;
    invalidateCaches();
    activeReviewUrl = url;
    retryDelay = 2000;
    retryAt = Infinity;
    if (!url) return;
    // The original inline bootstrap belongs only to the initially loaded URL.
    // SPA navigation fetches that review's HTML instead of reusing stale scripts.
    const initialData = useInitialDocument === true ? extractPageData() : null;
    if (initialData) installReview(initialData);
    else loadReview(url, navigationRevision);
  }

  function init() {
    syncReviewLocation(true);
    window.addEventListener('popstate', () => syncReviewLocation());
    // pushState in the page's isolated JS world emits no popstate event.
    setInterval(() => syncReviewLocation(), 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
