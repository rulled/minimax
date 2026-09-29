'use strict';

// Pure helpers for the two-stream parallel batch mode.
// Tested by tests/parallel_batch.test.js.
//
// IMPORTANT: background.js importScripts()s this file at the service-worker
// top level and delegates to these functions. Keep behavior identical when
// editing; the inline copies are gone. SYNC markers in background.js point
// here. Functions here must not touch chrome.* — they are pure.

/**
 * Default empty parallel-batch state. Persisted under chrome.storage.local
 * key 'parallelBatchState' on every mutation.
 */
function getDefaultParallelBatchState() {
  return {
    phase: 'idle',
    isRunning: false,
    isPaused: false,
    isFallingBack: false,
    runId: null,
    primaryTabId: null,
    secondaryTabId: null,
    secondaryTabIds: [],
    originalJobs: [],
    workers: [],
    startedAt: null
  };
}

/**
 * Build an N-worker parallel plan from jobs (N = 2, 3, 4).
 *
 * Иерархическая 2-уровневая формула балансировки:
 * 1. Уровень 1 (jobs.length >= workerCount):
 *    LPT Bin-Packing по ЦЕЛЫМ файлам. Каждый файл/VSL озвучивается целиком
 *    в одном потоке от начала до конца, без разрыва контекста, прыжков языка
 *    и перемешивания файлов в папках загрузки.
 * 2. Уровень 2 (jobs.length < workerCount):
 *    Если загружен 1 файл или файлов меньше числа потоков:
 *    а) если уникальных голосов >= workerCount — LPT-раскладка по голосам.
 *    б) если голосов меньше — деление очереди на N сбалансированных сегментов.
 *
 * @param {Array<{queue: Array<{voiceId:string, text:string, [key:string]:*}>}>} jobs
 * @param {number} [workerCount=2] Желаемое число потоков (2..4)
 * @returns {{ok:boolean, workers?:Array, strategy?:string, reason?:string}}
 */
function buildParallelPlan(jobs, workerCount = 2) {
  const targetCount = Math.max(2, Math.min(4, Number(workerCount || 2)));
  const totalEntries = (jobs || []).reduce((total, job) => total + (job.queue || []).length, 0);
  if (totalEntries === 0) {
    return { ok: false, reason: 'Очередь реплик пуста' };
  }

  // --- УРОВЕНЬ 1: Мульти-файловый режим (файлов >= потоков) ---
  if ((jobs || []).length >= targetCount) {
    const sortedJobs = jobs.map((job, idx) => ({
      idx,
      job,
      weight: (job.queue || []).reduce((sum, e) => sum + String(e.text || '').length, 0)
    })).sort((a, b) => b.weight - a.weight);

    const workers = Array.from({ length: targetCount }, (_, i) => ({
      workerId: `worker-${i + 1}`,
      queue: [],
      weight: 0
    }));

    for (const item of sortedJobs) {
      workers.sort((a, b) => a.weight - b.weight);
      workers[0].queue.push(...item.job.queue);
      workers[0].weight += item.weight;
    }
    workers.sort((a, b) => a.workerId.localeCompare(b.workerId));

    // Если каждый поток получил хотя бы одну реплику — файловый план готов
    if (!workers.some((worker) => worker.queue.length === 0)) {
      return { ok: true, strategy: 'file_level', workers };
    }
  }

  // --- УРОВЕНЬ 2: Одиночный или малый файл (файлов < потоков) ---
  const allEntries = (jobs || []).flatMap((job) => job.queue || []);
  const groups = new Map();

  allEntries.forEach((entry) => {
    const voiceId = String(entry.voiceId || '').trim();
    if (!voiceId) return;
    if (!groups.has(voiceId)) groups.set(voiceId, []);
    groups.get(voiceId).push(entry);
  });

  // 2a. Раскладка по голосам (если все реплики с голосами и голосов >= targetCount)
  const mappedEntries = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
  if (mappedEntries === totalEntries && groups.size >= targetCount) {
    const workers = Array.from({ length: targetCount }, (_, i) => ({
      workerId: `worker-${i + 1}`,
      queue: [],
      weight: 0
    }));

    const sortedGroups = [...groups.entries()].sort((a, b) => {
      const weightA = a[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
      const weightB = b[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
      return weightB - weightA;
    });

    sortedGroups.forEach(([, entries]) => {
      workers.sort((a, b) => a.weight - b.weight);
      workers[0].queue.push(...entries);
      workers[0].weight += entries.reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    });
    workers.sort((a, b) => a.workerId.localeCompare(b.workerId));

    if (!workers.some((worker) => worker.queue.length === 0)) {
      return { ok: true, strategy: 'voice_level', workers };
    }
  }

  // 2b. Деление по непрерывным сегментам реплик (сбалансированные чанки)
  const workers = Array.from({ length: targetCount }, (_, i) => ({
    workerId: `worker-${i + 1}`,
    queue: [],
    weight: 0
  }));
  const chunkSize = Math.ceil(allEntries.length / targetCount);
  for (let i = 0; i < targetCount; i++) {
    const slice = allEntries.slice(i * chunkSize, (i + 1) * chunkSize);
    workers[i].queue = slice;
    workers[i].weight = slice.reduce((sum, entry) => sum + String(entry.text || '').length, 0);
  }

  const activeWorkers = workers.filter((worker) => worker.queue.length > 0);
  if (activeWorkers.length < 2) {
    return { ok: false, reason: 'Слишком мало реплик для разделения на несколько потоков' };
  }

  return { ok: true, strategy: 'chunk_level', workers: activeWorkers };
}

/**
 * Redacted projection of a worker queue for state persistence — only the
 * fields the SW needs to track progress/recovery, never full text.
 */
function getParallelQueueSnapshot(queue) {
  return (Array.isArray(queue) ? queue : []).map((entry) => ({
    _parallelKey: entry._parallelKey,
    id: entry.id,
    speaker: String(entry.speaker || ''),
    voiceName: String(entry.voiceName || entry.voiceId || ''),
    // `preview` is produced by parser.js; keep it bounded so the persisted
    // state remains display-safe and never carries the full source text.
    preview: String(entry.preview || '').slice(0, 160),
    status: entry.status || 'pending',
    downloadConfirmed: entry.downloadConfirmed === true,
    paidSubmissionStarted: entry.paidSubmissionStarted === true,
    submissionRejected: entry.submissionRejected === true,
    submittedAt: Number(entry.submittedAt || 0),
    error: entry.error || null
  }));
}

/**
 * Display-safe worker summary for the popup. It intentionally reads only the
 * redacted worker queue persisted by getParallelQueueSnapshot().
 */
function getParallelWorkerSummary(worker) {
  const queue = Array.isArray(worker?.queue) ? worker.queue : [];
  const total = Number(worker?.total || queue.length) || queue.length;
  const currentIndex = Math.max(0, Number(worker?.currentIndex || 0));
  const currentEntry = currentIndex < queue.length ? queue[currentIndex] : null;
  const completed = queue.filter((entry) => (
    entry.status === 'completed' || entry.downloadConfirmed === true
  )).length;
  const errors = queue.filter((entry) => entry.status === 'error').length;

  return {
    workerId: worker?.workerId || '',
    status: worker?.status || 'pending',
    currentIndex,
    total,
    completed,
    errors,
    currentEntry: currentEntry ? {
      id: currentEntry.id,
      speaker: currentEntry.speaker || '',
      voiceName: currentEntry.voiceName || '',
      preview: String(currentEntry.preview || '').slice(0, 160),
      status: currentEntry.status || 'pending',
      error: currentEntry.error || null
    } : null
  };
}

/**
 * Protected-entry predicate for fallback. An entry is protected (kept out of
 * the legacy retry) when it completed, was skipped, had its submission
 * started/rejected, or was download-confirmed. This prevents double payment.
 */
function isEntryProtected(entry) {
  return entry.status === 'completed'
    || entry.status === 'skipped_manual'
    || entry.status === 'skipped_voice_not_found'
    || entry.downloadConfirmed === true
    || entry.paidSubmissionStarted === true
    || entry.submissionRejected === true;
}

/**
 * Pure form of buildRemainingParallelJobs: given the current workers and the
 * original jobs, return the jobs whose entries are NOT yet protected.
 *
 * @param {Array<{queue:Array}>} workers
 * @param {Array<{queue:Array}>} originalJobs
 * @returns {Array<{queue:Array}>} jobs with only unprotected entries
 */
function buildRemainingFromWorkers(workers, originalJobs) {
  const protectedKeys = new Set((workers || []).flatMap((worker) => {
    return (worker.queue || [])
      .filter(isEntryProtected)
      .map((entry) => entry._parallelKey)
      .filter((key) => key != null);
  }));

  return (originalJobs || [])
    .map((job) => ({
      ...job,
      queue: job.queue.filter((entry) => !protectedKeys.has(entry._parallelKey))
    }))
    .filter((job) => job.queue.length > 0);
}

// Dual export: Node tests use module.exports; the MV3 service worker uses
// importScripts() which has no module system, so also assign to the global
// object (self) under a namespace. background.js reads from this namespace.
const __pbExports = {
  getDefaultParallelBatchState,
  buildParallelPlan,
  getParallelQueueSnapshot,
  getParallelWorkerSummary,
  isEntryProtected,
  buildRemainingFromWorkers
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __pbExports;
}
if (typeof self !== 'undefined') {
  self.parallel_batch = __pbExports;
}
