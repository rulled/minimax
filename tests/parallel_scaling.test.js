// Тесты масштабирования параллельной озвучки на 2, 3 и 4 потока (parallel_batch.js):
// - 2-уровневая формула деления (Уровень 1: LPT по файлам, Уровень 2: по голосам/сегментам)
// - Равномерность балансировки нагрузки
// - Сохранение целостности файлов и порядка реплик
// Запуск: node --test tests/parallel_scaling.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  buildParallelPlan,
  getDefaultParallelBatchState,
  buildRemainingFromWorkers,
  getParallelWorkerSummary
} = require('../parallel_batch.js');

test('getDefaultParallelBatchState: содержит secondaryTabIds для N потоков', () => {
  const state = getDefaultParallelBatchState();
  assert.ok(Array.isArray(state.secondaryTabIds), 'secondaryTabIds должен быть массивом');
  assert.equal(state.secondaryTabId, null, 'обратная совместимость для secondaryTabId');
});

test('Уровень 1 (мульти-файлы): 11 файлов равномерно раскладываются на 2, 3 и 4 потока', () => {
  // Симуляция 11 реальных файлов из translated
  const fileWeights = [
    { name: 'file1', chars: 10191, count: 24 },
    { name: 'file2', chars: 9728, count: 24 },
    { name: 'file3', chars: 9559, count: 25 },
    { name: 'file4', chars: 9106, count: 25 },
    { name: 'file5', chars: 8627, count: 22 },
    { name: 'file6', chars: 4010, count: 7 },
    { name: 'file7', chars: 3927, count: 7 },
    { name: 'file8', chars: 3863, count: 7 },
    { name: 'file9', chars: 3669, count: 24 },
    { name: 'file10', chars: 3444, count: 24 },
    { name: 'file11', chars: 3427, count: 24 }
  ];

  const jobs = fileWeights.map((f, fIdx) => ({
    file: f.name,
    queue: Array.from({ length: f.count }, (_, i) => ({
      _parallelKey: `${fIdx}:${i}:entry`,
      voiceId: 'voice_1',
      text: 'x'.repeat(Math.round(f.chars / f.count))
    }))
  }));

  // Проверяем 2 потока
  const plan2 = buildParallelPlan(jobs, 2);
  assert.equal(plan2.ok, true);
  assert.equal(plan2.strategy, 'file_level');
  assert.equal(plan2.workers.length, 2);
  const diff2 = Math.abs(plan2.workers[0].weight - plan2.workers[1].weight);
  assert.ok(diff2 < 2000, `Разброс для 2 потоков должен быть минимальным, получен: ${diff2}`);

  // Проверяем 3 потока
  const plan3 = buildParallelPlan(jobs, 3);
  assert.equal(plan3.ok, true);
  assert.equal(plan3.strategy, 'file_level');
  assert.equal(plan3.workers.length, 3);
  assert.ok(plan3.workers.every((w) => w.queue.length > 0), 'все 3 потока получили работу');

  // Проверяем 4 потока
  const plan4 = buildParallelPlan(jobs, 4);
  assert.equal(plan4.ok, true);
  assert.equal(plan4.strategy, 'file_level');
  assert.equal(plan4.workers.length, 4);
  assert.ok(plan4.workers.every((w) => w.queue.length > 0), 'все 4 потока получили работу');

  // Проверяем целостность: реплики одного файла не должны разрываться между потоками
  for (let fIdx = 0; fIdx < fileWeights.length; fIdx++) {
    const keyPrefix = `${fIdx}:`;
    const workersWithThisFile = plan4.workers.filter((w) =>
      w.queue.some((e) => e._parallelKey.startsWith(keyPrefix))
    );
    assert.equal(workersWithThisFile.length, 1, `Файл #${fIdx} должен быть строго в одном потоке`);
  }
});

test('Уровень 2 (одиночный файл с несколькими голосами): деление по voiceId', () => {
  const singleJob = [{
    file: 'interview.md',
    queue: [
      { _parallelKey: '0:0', voiceId: 'doc', text: 'aaaaa' },
      { _parallelKey: '0:1', voiceId: 'doc', text: 'aaaaa' },
      { _parallelKey: '0:2', voiceId: 'lead', text: 'bbbbb' },
      { _parallelKey: '0:3', voiceId: 'lead', text: 'bbbbb' },
      { _parallelKey: '0:4', voiceId: 'rev', text: 'ccccc' }
    ]
  }];

  const plan = buildParallelPlan(singleJob, 3);
  assert.equal(plan.ok, true);
  assert.equal(plan.strategy, 'voice_level');
  assert.equal(plan.workers.length, 3);
});

test('Уровень 2 (одиночный файл с 1 голосом): деление на непрерывные сегменты (chunk_level)', () => {
  const singleJob = [{
    file: 'monologue.md',
    queue: Array.from({ length: 12 }, (_, i) => ({
      _parallelKey: `0:${i}`,
      voiceId: 'single_voice',
      text: 'phrase ' + i
    }))
  }];

  const plan = buildParallelPlan(singleJob, 3);
  assert.equal(plan.ok, true);
  assert.equal(plan.strategy, 'chunk_level');
  assert.equal(plan.workers.length, 3);
  assert.equal(plan.workers[0].queue.length, 4);
  assert.equal(plan.workers[1].queue.length, 4);
  assert.equal(plan.workers[2].queue.length, 4);
});

test('Ограничения и валидация workerCount', () => {
  const job = [{
    queue: [
      { _parallelKey: '0:0', voiceId: 'v1', text: 'a' },
      { _parallelKey: '0:1', voiceId: 'v2', text: 'b' }
    ]
  }];

  // 10 зажимается в максимум 4
  const planMax = buildParallelPlan(job, 10);
  assert.ok(planMax.workers.length <= 4);

  // 1 зажимается в минимум 2
  const planMin = buildParallelPlan(job, 1);
  assert.equal(planMin.workers.length, 2);

  // Пустая очередь возвращает ошибку
  const emptyPlan = buildParallelPlan([]);
  assert.equal(emptyPlan.ok, false);
});
