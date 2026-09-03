'use strict';

// Regression tests for pure parallel-batch helpers (tests/parallel_batch.test.js).
// Run: node --test tests/parallel_batch.test.js
//
// SYNC: tests the pure module parallel_batch.js, which background.js
// importScripts()s and delegates to. If behavior here changes, update both.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDefaultParallelBatchState,
  buildParallelPlan,
  getParallelQueueSnapshot,
  getParallelWorkerSummary,
  isEntryProtected,
  buildRemainingFromWorkers
} = require('../parallel_batch.js');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function entry(overrides = {}) {
  return Object.assign(
    {
      _parallelKey: 'k-0',
      id: 'e-0',
      voiceId: 'voice-a',
      text: 'text',
      status: 'pending'
    },
    overrides
  );
}

function jobOf(entries) {
  return { queue: entries };
}

// ---------------------------------------------------------------------------
// getDefaultParallelBatchState
// ---------------------------------------------------------------------------

test('getDefaultParallelBatchState: idle, not running, empty workers/jobs', () => {
  const s = getDefaultParallelBatchState();
  assert.equal(s.phase, 'idle');
  assert.equal(s.isRunning, false);
  assert.equal(s.isPaused, false);
  assert.equal(s.isFallingBack, false);
  assert.equal(s.runId, null);
  assert.deepEqual(s.workers, []);
  assert.deepEqual(s.originalJobs, []);
});

test('getDefaultParallelBatchState: returns a fresh object each call', () => {
  const a = getDefaultParallelBatchState();
  const b = getDefaultParallelBatchState();
  assert.notEqual(a, b);
  a.workers.push({ workerId: 'x' });
  assert.equal(b.workers.length, 0);
});

// ---------------------------------------------------------------------------
// buildParallelPlan — happy paths
// ---------------------------------------------------------------------------

test('buildParallelPlan: two voices split across two workers, all entries kept', () => {
  const jobs = [
    jobOf([entry({ _parallelKey: 'a1', voiceId: 'A', text: 'aaaa' }), entry({ _parallelKey: 'a2', voiceId: 'A', text: 'aa' })]),
    jobOf([entry({ _parallelKey: 'b1', voiceId: 'B', text: 'bbbb' })])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, true);
  assert.equal(plan.workers.length, 2);

  const totalEntries = plan.workers.reduce((n, w) => n + w.queue.length, 0);
  assert.equal(totalEntries, 3);

  // Each worker non-empty and queue keys preserved.
  const keys = plan.workers.flatMap((w) => w.queue.map((e) => e._parallelKey)).sort();
  assert.deepEqual(keys, ['a1', 'a2', 'b1']);
});

test('buildParallelPlan: a voice is never split across workers', () => {
  const jobs = [
    jobOf([
      entry({ _parallelKey: 'a1', voiceId: 'A', text: 'aaaaa' }),
      entry({ _parallelKey: 'b1', voiceId: 'B', text: 'bb' }),
      entry({ _parallelKey: 'c1', voiceId: 'C', text: 'cc' })
    ])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, true);
  for (const worker of plan.workers) {
    const voicesInWorker = new Set(worker.queue.map((e) => e.voiceId));
    // Each worker holds whole voice-groups; no entry's voice appears in both.
    for (const v of voicesInWorker) {
      const inOther = plan.workers.find((w) => w !== worker).queue.some((e) => e.voiceId === v);
      assert.equal(inOther, false, `voice ${v} split across workers`);
    }
  }
});

test('buildParallelPlan: heaviest voice assigned when workers are empty (greedy order)', () => {
  // Voice A is heavy (weight 20), B and C light (5, 5). Heaviest-first means A
  // lands on worker-1 (the tie at 0<=0 picks index 0), then B/C on worker-2.
  const jobs = [
    jobOf([
      entry({ _parallelKey: 'a1', voiceId: 'A', text: 'x'.repeat(20) }),
      entry({ _parallelKey: 'b1', voiceId: 'B', text: 'bbbbb' }),
      entry({ _parallelKey: 'c1', voiceId: 'C', text: 'ccccc' })
    ])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, true);
  const w1Keys = plan.workers[0].queue.map((e) => e._parallelKey);
  const w2Keys = plan.workers[1].queue.map((e) => e._parallelKey);
  assert.deepEqual(w1Keys, ['a1']);
  assert.deepEqual(w2Keys.sort(), ['b1', 'c1']);
});

test('buildParallelPlan: entries across multiple jobs with same voice merge into one group', () => {
  const jobs = [
    jobOf([entry({ _parallelKey: 'a1', voiceId: 'A', text: 'aa' })]),
    jobOf([entry({ _parallelKey: 'a2', voiceId: 'A', text: 'aa' })]),
    jobOf([entry({ _parallelKey: 'b1', voiceId: 'B', text: 'bbbb' })])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, true);
  // Voice A (weight 4) vs B (weight 4). A's two entries stay together.
  const workerWithA = plan.workers.find((w) => w.queue.some((e) => e.voiceId === 'A'));
  assert.equal(workerWithA.queue.filter((e) => e.voiceId === 'A').length, 2);
});

test('buildParallelPlan: missing text is counted as zero weight, does not crash', () => {
  const jobs = [
    jobOf([
      entry({ _parallelKey: 'a1', voiceId: 'A', text: undefined }),
      entry({ _parallelKey: 'b1', voiceId: 'B', text: 'bbbb' })
    ])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, true);
});

// ---------------------------------------------------------------------------
// buildParallelPlan — rejections
// ---------------------------------------------------------------------------

test('buildParallelPlan: rejects when an entry has no voiceId', () => {
  const jobs = [
    jobOf([
      entry({ _parallelKey: 'a1', voiceId: 'A', text: 'aa' }),
      entry({ _parallelKey: 'b1', voiceId: '', text: 'bb' })
    ])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /голоса у всех реплик/);
});

test('buildParallelPlan: rejects on whitespace-only voiceId (trimmed to empty)', () => {
  const jobs = [
    jobOf([
      entry({ _parallelKey: 'a1', voiceId: 'A', text: 'aa' }),
      entry({ _parallelKey: 'b1', voiceId: '   ', text: 'bb' })
    ])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /голоса у всех реплик/);
});

test('buildParallelPlan: rejects when all entries share one voice', () => {
  const jobs = [
    jobOf([
      entry({ _parallelKey: 'a1', voiceId: 'A', text: 'aa' }),
      entry({ _parallelKey: 'a2', voiceId: 'A', text: 'aa' })
    ])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /минимум два разных голоса/);
});

test('buildParallelPlan: rejects on empty jobs array (zero voices)', () => {
  const plan = buildParallelPlan([]);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /минимум два разных голоса/);
});

test('buildParallelPlan: falsy numeric voiceId 0 is rejected as missing', () => {
  // `entry.voiceId || ''` deliberately treats 0 as absent: real MiniMax
  // voiceIds are non-empty string identifiers, never zero.
  const jobs = [
    jobOf([entry({ _parallelKey: 'a1', voiceId: 0, text: 'aa' }), entry({ _parallelKey: 'b1', voiceId: 1, text: 'bb' })])
  ];
  const plan = buildParallelPlan(jobs);
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /голоса у всех реплик/);
});

// ---------------------------------------------------------------------------
// getParallelQueueSnapshot
// ---------------------------------------------------------------------------

test('getParallelQueueSnapshot: projects redacted fields only (no text)', () => {
  const queue = [
    entry({ _parallelKey: 'k1', id: 'i1', status: 'completed', downloadConfirmed: true, paidSubmissionStarted: true, submissionRejected: false, submittedAt: 123, error: null, text: 'SECRET_LONG_TEXT' })
  ];
  const snap = getParallelQueueSnapshot(queue);
  assert.equal(snap.length, 1);
  assert.deepEqual(snap[0], {
    _parallelKey: 'k1',
    id: 'i1',
    speaker: '',
    voiceName: 'voice-a',
    preview: '',
    status: 'completed',
    downloadConfirmed: true,
    paidSubmissionStarted: true,
    submissionRejected: false,
    submittedAt: 123,
    error: null
  });
  assert.equal(Object.prototype.hasOwnProperty.call(snap[0], 'text'), false, 'snapshot must not carry full text');
});

test('getParallelQueueSnapshot: defaults — pending status, false flags, submittedAt 0', () => {
  const snap = getParallelQueueSnapshot([{ _parallelKey: 'k', id: 'i' }]);
  assert.equal(snap[0].status, 'pending');
  assert.equal(snap[0].downloadConfirmed, false);
  assert.equal(snap[0].paidSubmissionStarted, false);
  assert.equal(snap[0].submissionRejected, false);
  assert.equal(snap[0].submittedAt, 0);
});

test('getParallelQueueSnapshot: keeps display data but never full text', () => {
  const snap = getParallelQueueSnapshot([entry({
    speaker: 'ДИКТОР',
    voiceName: 'о1',
    preview: 'p'.repeat(200),
    text: 'FULL_SCRIPT_MUST_NOT_BE_PERSISTED'
  })]);
  assert.equal(snap[0].speaker, 'ДИКТОР');
  assert.equal(snap[0].voiceName, 'о1');
  assert.equal(snap[0].preview.length, 160);
  assert.equal(Object.prototype.hasOwnProperty.call(snap[0], 'text'), false);
});

test('getParallelWorkerSummary: derives current entry and aggregate worker counts', () => {
  const worker = {
    workerId: 'worker-1',
    status: 'running',
    currentIndex: 1,
    total: 3,
    queue: getParallelQueueSnapshot([
      entry({ id: 'done', speaker: 'A', voiceName: 'voice A', preview: 'first', status: 'completed' }),
      entry({ id: 'now', speaker: 'B', voiceName: 'voice B', preview: 'second', status: 'processing' }),
      entry({ id: 'bad', speaker: 'C', voiceName: 'voice C', preview: 'third', status: 'error', error: 'failed' })
    ])
  };
  assert.deepEqual(getParallelWorkerSummary(worker), {
    workerId: 'worker-1',
    status: 'running',
    currentIndex: 1,
    total: 3,
    completed: 1,
    errors: 1,
    currentEntry: {
      id: 'now', speaker: 'B', voiceName: 'voice B', preview: 'second', status: 'processing', error: null
    }
  });
});

test('getParallelQueueSnapshot: non-array input returns empty array', () => {
  assert.deepEqual(getParallelQueueSnapshot(undefined), []);
  assert.deepEqual(getParallelQueueSnapshot(null), []);
});

// ---------------------------------------------------------------------------
// isEntryProtected
// ---------------------------------------------------------------------------

test('isEntryProtected: completed / skips / flags protect an entry', () => {
  assert.equal(isEntryProtected(entry({ status: 'completed' })), true);
  assert.equal(isEntryProtected(entry({ status: 'skipped_manual' })), true);
  assert.equal(isEntryProtected(entry({ status: 'skipped_voice_not_found' })), true);
  assert.equal(isEntryProtected(entry({ downloadConfirmed: true })), true);
  assert.equal(isEntryProtected(entry({ paidSubmissionStarted: true })), true);
  assert.equal(isEntryProtected(entry({ submissionRejected: true })), true);
});

test('isEntryProtected: plain pending / error / unknown status are NOT protected', () => {
  assert.equal(isEntryProtected(entry({ status: 'pending' })), false);
  assert.equal(isEntryProtected(entry({ status: 'in_progress' })), false);
  // error status alone (no submission/payment marker) is retriable.
  assert.equal(isEntryProtected(entry({ status: 'error' })), false);
});

// ---------------------------------------------------------------------------
// buildRemainingFromWorkers
// ---------------------------------------------------------------------------

test('buildRemainingFromWorkers: protected entries dropped, pending kept', () => {
  const workers = [
    {
      workerId: 'worker-1',
      queue: [
        entry({ _parallelKey: 'done-1', status: 'completed', paidSubmissionStarted: true, downloadConfirmed: true }),
        entry({ _parallelKey: 'pending-1', status: 'pending' })
      ]
    }
  ];
  const originalJobs = [
    jobOf([
      entry({ _parallelKey: 'done-1', voiceId: 'A' }),
      entry({ _parallelKey: 'pending-1', voiceId: 'B' })
    ])
  ];
  const remaining = buildRemainingFromWorkers(workers, originalJobs);
  assert.equal(remaining.length, 1);
  const keys = remaining[0].queue.map((e) => e._parallelKey);
  assert.deepEqual(keys, ['pending-1']);
});

test('buildRemainingFromWorkers: job fully protected is dropped from result', () => {
  const workers = [
    { workerId: 'worker-1', queue: [entry({ _parallelKey: 'done-1', status: 'completed', downloadConfirmed: true })] }
  ];
  const originalJobs = [jobOf([entry({ _parallelKey: 'done-1' })])];
  const remaining = buildRemainingFromWorkers(workers, originalJobs);
  assert.equal(remaining.length, 0);
});

test('buildRemainingFromWorkers: paidSubmissionStarted protects even when not completed', () => {
  // The key anti-double-pay case: a submission started but never confirmed must
  // NOT be re-queued for legacy retry.
  const workers = [
    { workerId: 'w1', queue: [entry({ _parallelKey: 'paid', status: 'in_progress', paidSubmissionStarted: true })] }
  ];
  const originalJobs = [jobOf([entry({ _parallelKey: 'paid' })])];
  const remaining = buildRemainingFromWorkers(workers, originalJobs);
  assert.equal(remaining.length, 0);
});

test('buildRemainingFromWorkers: does not mutate originalJobs', () => {
  const workers = [{ workerId: 'w1', queue: [entry({ _parallelKey: 'done', status: 'completed' })] }];
  const origEntry = entry({ _parallelKey: 'done' });
  const originalJobs = [jobOf([origEntry, entry({ _parallelKey: 'pend' })])];
  buildRemainingFromWorkers(workers, originalJobs);
  assert.equal(originalJobs[0].queue.length, 2, 'original queue not mutated');
});

test('buildRemainingFromWorkers: null/undefined inputs yield empty', () => {
  assert.deepEqual(buildRemainingFromWorkers(undefined, undefined), []);
  assert.deepEqual(buildRemainingFromWorkers(null, null), []);
});

test('buildRemainingFromWorkers: empty workers means everything remains', () => {
  const originalJobs = [
    jobOf([entry({ _parallelKey: 'a' }), entry({ _parallelKey: 'b' })])
  ];
  const remaining = buildRemainingFromWorkers([], originalJobs);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].queue.length, 2);
});

test('buildRemainingFromWorkers: worker with missing queue is tolerated', () => {
  const originalJobs = [jobOf([entry({ _parallelKey: 'a' })])];
  const remaining = buildRemainingFromWorkers([{ workerId: 'w1' }], originalJobs);
  assert.equal(remaining.length, 1);
});
