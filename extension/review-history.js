/* History payloads expose created_at, but do not expose review iteration numbers. */
(function () {
  'use strict';

  function timestamp(entry) {
    const value = entry?.created_at;
    // Require an explicit timezone so ordering does not depend on the browser locale.
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }

  function id(entry) {
    return typeof entry?.id === 'string' && entry.id !== '' ? entry.id
      : typeof entry?.id === 'number' && Number.isFinite(entry.id) ? String(entry.id) : null;
  }

  function selectHistory(homework, history, currentReview) {
    // currentReview.iteration describes the current review only; it cannot label
    // individual history records or establish their submission chronology.
    const currentTime = timestamp(homework);
    const currentId = id(homework);
    const rows = (Array.isArray(history) ? history : []).filter(entry => {
      const sources = entry?.data?.sources;
      if (!Array.isArray(sources) || !sources.every(source => source &&
        typeof source.file === 'string' && typeof source.source === 'string')) return false;
      if (entry === homework || (currentId !== null && id(entry) === currentId)) return false;
      const time = timestamp(entry);
      return currentTime === null || time === null || time <= currentTime;
    }).map(historyEntry => ({
      historyEntry,
      time: timestamp(historyEntry),
      id: id(historyEntry),
      key: JSON.stringify(historyEntry.data.sources.map(source => [source.file, source.source])),
    }));

    // Dated records are chronological. Undated records follow in a stable order,
    // explicitly marked unknown; their position must never imply chronology.
    rows.sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) ||
      compare(a.id ?? '', b.id ?? '') || compare(a.key, b.key));
    const seen = new Map();
    let conflictingDuplicate = false;
    const unique = rows.filter(row => {
      if (row.id === null) return true;
      if (seen.has(row.id)) {
        const existing = seen.get(row.id);
        if (existing.time !== row.time || existing.key !== row.key) conflictingDuplicate = true;
        return false;
      }
      seen.set(row.id, row);
      return true;
    });
    const latest = unique[unique.length - 1];
    const unambiguous = !conflictingDuplicate && currentTime !== null && latest &&
      unique.every(row => row.time !== null) && latest.time < currentTime &&
      (unique.length === 1 || unique[unique.length - 2].time !== latest.time);
    return {
      previous: unambiguous ? latest.historyEntry.data.sources : null,
      allIterations: unique.map((row, index) => ({
        historyEntry: row.historyEntry,
        label: `Итерация ${index + 1}` + (row.time === null ? ' — порядок неизвестен' : ''),
        title: row.time === null ? 'Дата сдачи неизвестна' : `Сдано: ${new Date(row.time).toISOString()}`,
      })),
    };
  }

  function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  globalThis.RevizorroReviewHistory = { selectHistory };
  if (typeof module !== 'undefined' && module.exports) module.exports = { selectHistory };
})();
