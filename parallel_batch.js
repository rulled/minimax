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
    originalJobs: [],
    workers: [],
    startedAt: null
  };
}

/**
 * Build a two-worker parallel plan from jobs.
 *
 * Groups entries by voiceId (a voice is never split across workers), then
 * greedily assigns whole voice-groups to whichever worker has the lower
 * cumulative text-length weight, heaviest-group-first.
 *
 * Rejects when:
 *   - any entry is missing voiceId
 *   - fewer than 2 distinct voiceIds
 *   - the greedy assignment leaves a worker empty (one voice outweighs all
 *     others combined)
 *
 * @param {Array<{queue: Array<{voiceId:string, text:string, [key:string]:*}>}>} jobs
 * @returns {{ok:boolean, workers?:Array, reason?:string}}
 */
function buildParallelPlan(jobs) {
  const groups = new Map();

  jobs.forEach((job) => {
    job.queue.forEach((entry) => {
      const voiceId = String(entry.voiceId || '').trim();
      if (!voiceId) return;
      if (!groups.has(voiceId)) groups.set(voiceId, []);
      groups.get(voiceId).push(entry);
    });
  });

  const totalEntries = jobs.reduce((total, job) => total + job.queue.length, 0);
  const mappedEntries = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
  if (mappedEntries !== totalEntries) {
    return { ok: false, reason: 'Для двух потоков нужны голоса у всех реплик' };
  }
  if (groups.size < 2) {
    return { ok: false, reason: 'Для двух потоков нужны минимум два разных голоса' };
  }

  const workers = [
    { workerId: 'worker-1', queue: [], weight: 0 },
    { workerId: 'worker-2', queue: [], weight: 0 }
  ];
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const weightA = a[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    const weightB = b[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    return weightB - weightA;
  });

  sortedGroups.forEach(([, entries]) => {
    const target = workers[0].weight <= workers[1].weight ? workers[0] : workers[1];
    target.queue.push(...entries);
    target.weight += entries.reduce((sum, entry) => sum + String(entry.text || '').length, 0);
  });

  if (workers.some((worker) => worker.queue.length === 0)) {
    return { ok: false, reason: 'Не удалось равномерно разделить очередь' };
  }

  return { ok: true, workers };
}

/**
 * Redacted projection of a worker queue for state persistence — only the
 * fields the SW needs to track progress/recovery, never full text.
 */
function getParallelQueueSnapshot(queue) {
  return (Array.isArray(queue) ? queue : []).map((entry) => ({
    _parallelKey: entry._parallelKey,
    id: entry.id,
    status: entry.status || 'pending',
    downloadConfirmed: entry.downloadConfirmed === true,
    paidSubmissionStarted: entry.paidSubmissionStarted === true,
    submissionRejected: entry.submissionRejected === true,
    submittedAt: Number(entry.submittedAt || 0),
    error: entry.error || null
  }));
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
      .map((entry) => entry._parallelKey);
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
  isEntryProtected,
  buildRemainingFromWorkers
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = __pbExports;
}
if (typeof self !== 'undefined') {
  self.parallel_batch = __pbExports;
}
