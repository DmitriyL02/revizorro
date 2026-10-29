// Exact line diff, shared by the content script and Node regression tests.
(function () {
  'use strict';

  function* lineDiffSteps(oldText, newText) {
    // Empty source has no lines; an actual newline retains both blank lines.
    const oldLines = oldText ? oldText.split('\n') : [];
    const newLines = newText ? newText.split('\n') : [];
    const result = [];
    let forward;
    let backward;
    let work = 0;

    function context(i, j) {
      result.push({ type: 'context', line: oldLines[i], oldNum: i + 1, newNum: j + 1 });
    }
    function removed(i) {
      result.push({ type: 'removed', line: oldLines[i], oldNum: i + 1 });
    }
    function added(j) {
      result.push({ type: 'added', line: newLines[j], newNum: j + 1 });
    }

    // Hirschberg reconstructs an LCS without an n*m direction table. Two
    // reusable rows bound scratch memory to O(m); splitting the old range in
    // half bounds stack depth to O(log n). Worst-case time is O(n*m), total
    // memory including input lines and output is O(n+m). Shared edges are
    // stripped at every split, so a localized edit in a huge file stays cheap.
    function* visit(oldStart, oldEnd, newStart, newEnd) {
      while (oldStart < oldEnd && newStart < newEnd && oldLines[oldStart] === newLines[newStart]) {
        context(oldStart++, newStart++);
        if (++work % 8192 === 0) yield;
      }
      let suffix = 0;
      while (oldStart < oldEnd && newStart < newEnd && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
        oldEnd--;
        newEnd--;
        suffix++;
        if (++work % 8192 === 0) yield;
      }

      if (oldStart === oldEnd) {
        for (let j = newStart; j < newEnd; j++) {
          added(j);
          if (++work % 8192 === 0) yield;
        }
      } else if (newStart === newEnd) {
        for (let i = oldStart; i < oldEnd; i++) {
          removed(i);
          if (++work % 8192 === 0) yield;
        }
      } else if (oldEnd - oldStart === 1) {
        let match = newStart;
        while (match < newEnd && oldLines[oldStart] !== newLines[match]) {
          match++;
          if (++work % 8192 === 0) yield;
        }
        if (match === newEnd) removed(oldStart);
        for (let j = newStart; j < newEnd; j++) {
          if (j === match) context(oldStart, j);
          else added(j);
          if (++work % 8192 === 0) yield;
        }
      } else {
        const width = newEnd - newStart;
        // Allocation is lazy: identical files and a single changed line need
        // no score rows. Descendant subproblems reuse these same buffers.
        if (!forward) {
          forward = new Uint32Array(width + 1);
          backward = new Uint32Array(width + 1);
        }
        forward.fill(0, 0, width + 1);
        backward.fill(0, 0, width + 1);
        const middle = oldStart + Math.floor((oldEnd - oldStart) / 2);
        for (let i = oldStart; i < middle; i++) {
          let diagonal = 0;
          for (let j = 1; j <= width; j++) {
            const previous = forward[j];
            forward[j] = oldLines[i] === newLines[newStart + j - 1]
              ? diagonal + 1 : Math.max(previous, forward[j - 1]);
            diagonal = previous;
            if (++work % 8192 === 0) yield;
          }
        }
        for (let i = oldEnd - 1; i >= middle; i--) {
          let diagonal = 0;
          for (let j = width - 1; j >= 0; j--) {
            const previous = backward[j];
            backward[j] = oldLines[i] === newLines[newStart + j]
              ? diagonal + 1 : Math.max(previous, backward[j + 1]);
            diagonal = previous;
            if (++work % 8192 === 0) yield;
          }
        }
        let split = 0;
        let best = -1;
        for (let j = 0; j <= width; j++) {
          if (++work % 8192 === 0) yield;
          const score = forward[j] + backward[j];
          if (score > best) {
            best = score;
            split = j;
          }
        }
        yield* visit(oldStart, middle, newStart, newStart + split);
        yield* visit(middle, oldEnd, newStart + split, newEnd);
      }
      for (let offset = 0; offset < suffix; offset++) {
        context(oldEnd + offset, newEnd + offset);
        if (++work % 8192 === 0) yield;
      }
    }

    yield* visit(0, oldLines.length, 0, newLines.length);
    return result;
  }

  // Synchronous entry point for diagnostics; the content script uses the queue.
  function computeLineDiff(oldText, newText) {
    const steps = lineDiffSteps(oldText, newText);
    let step;
    do { step = steps.next(); } while (!step.done);
    return step.value;
  }

  // A single budget for all files prevents many simultaneous calculations from
  // multiplying the time spent on the main thread. Cancelled jobs release their
  // generator (including its score buffers) before the next chunk runs.
  const jobs = [];
  let scheduled = false;
  function runJobs() {
    const deadline = performance.now() + 8;
    do {
      const job = jobs[0];
      try {
        if (job.isCancelled()) {
          jobs.shift();
          job.resolve(null);
        } else {
          const step = job.steps.next();
          if (step.done) {
            jobs.shift();
            job.resolve(step.value);
          }
        }
      } catch (error) {
        jobs.shift();
        job.reject(error);
      }
    } while (jobs.length && performance.now() < deadline);
    if (jobs.length) setTimeout(runJobs, 0);
    else scheduled = false;
  }

  function computeLineDiffAsync(oldText, newText, { isCancelled = () => false } = {}) {
    return new Promise((resolve, reject) => {
      jobs.push({ steps: lineDiffSteps(oldText, newText), isCancelled, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        setTimeout(runJobs, 0);
      }
    });
  }

  globalThis.RevizorroLineDiff = { computeLineDiff, computeLineDiffAsync };
  if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.RevizorroLineDiff;
})();
