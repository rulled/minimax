// Регресс 25.09: MiniMax вернул 2600018 «Your request is too frequent» на 7-й
// реплике из 24 — расширение пометило отправку неоднозначной и уронило очередь
// целиком (Fatal error in processQueue): 18 блоков файла не сгенерировались и
// следующий файл вообще не стартовал (ещё 10). Правильное поведение: реплика
// повторяется после паузы (~10 с), а любая ошибка, кроме неоднозначной оплаты,
// не убивает остаток очереди.
// Запуск: node --test tests/rate_limit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noop = () => {};

// content_script.js — классический скрипт расширения: грузим его целиком в VM
// с заглушками chrome/DOM, чтобы тестировать настоящий код, а не копию.
function loadAutomation() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8')
    + '\n;globalThis.__VoiceoverAutomation = VoiceoverAutomation;'
    + '\n;globalThis.__isRateLimitRejection = isRateLimitRejection;';
  const element = () => ({
    style: {}, classList: { add: noop, remove: noop, contains: () => false },
    setAttribute: noop, appendChild: noop, click: noop, remove: noop, focus: noop,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
    getAttribute: () => null, textContent: '', innerHTML: '', removeEventListener: noop,
  });
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: { randomUUID: () => 'test-uuid' },
    window: { addEventListener: noop, removeEventListener: noop, location: { href: 'https://minimax.io/' } },
    document: {
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      createElement: element, getElementById: () => null, execCommand: noop,
      body: element(), head: element(), documentElement: element(),
    },
    chrome: {
      runtime: { id: 'test', lastError: null, getURL: (url) => url, sendMessage: async () => ({ success: true }), onMessage: { addListener: noop } },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: noop } },
      downloads: { onDeterminingFilename: { addListener: noop }, download: async () => 1, search: async () => [] },
    },
    DiagLog: { info: noop, warn: noop, error: noop, log: noop, debug: noop },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'content_script.js' });
  return sandbox;
}

test('категория отказа из MiniMax: 2600018 распознаётся как лимит частоты', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const start = source.indexOf('const RATE_LIMIT_CODES');
  const end = source.indexOf('function isValidAudioUrl');
  assert.ok(start > 0 && end > start, 'классификатор отказа не найден в background.js');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source.slice(start, end) + '\n;globalThis.__classify = classifyDirectRejection;', sandbox);
  const classify = sandbox.__classify;
  assert.equal(classify('Your request is too frequent. Please try again later.', 2600018), 'rate_limit');
  assert.equal(classify('Your request is too frequent', null), 'rate_limit');
  assert.equal(classify('insufficient balance', 1004), 'insufficient_credit');
  assert.equal(classify('minimax_input_sensitive', null), 'server_rejected');
});

test('предикат лимита в контент-скрипте понимает код, категорию и текст', () => {
  const { __isRateLimitRejection: isRateLimit } = loadAutomation();
  assert.equal(isRateLimit({ code: 2600018, disposition: 'rejected' }), true);
  assert.equal(isRateLimit({ category: 'rate_limit', code: 1 }), true);
  assert.equal(isRateLimit({ reason: 'Your request is too frequent. Please try again later.' }), true);
  assert.equal(isRateLimit({ category: 'insufficient_credit', reason: 'insufficient balance' }), false);
  assert.equal(isRateLimit(null), false);
});

test('лимит частоты: реплика повторяется, очередь доходит до конца', async () => {
  const { __VoiceoverAutomation: Automation } = loadAutomation();
  const automation = new Automation();
  automation.sleep = async () => {}; // паузы в тесте не ждём
  const attempts = new Map();
  const completed = [];
  automation.processEntry = async (entry) => {
    const attempt = (attempts.get(entry.speaker) || 0) + 1;
    attempts.set(entry.speaker, attempt);
    if (entry.speaker === 'Доктор' && attempt <= 2) {
      // Так состояние выставляет rejected-ветка submit-пути: отправка отклонена
      // (повторять безопасно), лимит частоты.
      entry.submissionRejected = true;
      entry.rateLimited = true;
      throw new Error('Direct generation rejected by MiniMax: Your request is too frequent. Please try again later.');
    }
    completed.push(entry.speaker);
  };
  automation.queue = [
    { speaker: 'Доктор', text: 'a' },
    { speaker: 'Диктор', text: 'b' },
    { speaker: 'Отзыв 1 женщина(LATAM)', text: 'c' },
  ];
  automation.isRunning = true;

  await automation.processQueue();

  assert.equal(attempts.get('Доктор'), 3, 'реплика с лимитом должна переотправляться');
  assert.deepEqual(completed, ['Доктор', 'Диктор', 'Отзыв 1 женщина(LATAM)'], 'очередь должна дойти до конца');
  assert.equal(automation.queue[0].status, 'completed');
  assert.equal(automation.queue[0].error, undefined);
});

test('отказ сервера по одной реплике не убивает остаток очереди', async () => {
  const { __VoiceoverAutomation: Automation } = loadAutomation();
  const automation = new Automation();
  automation.sleep = async () => {};
  const completed = [];
  automation.processEntry = async (entry) => {
    if (entry.speaker === 'Доктор') {
      entry.submissionRejected = true; // запрос отклонён до списания, повторять нечего
      throw new Error('Direct generation rejected by MiniMax: minimax_input_sensitive');
    }
    completed.push(entry.speaker);
  };
  automation.queue = [
    { speaker: 'Диктор', text: 'a' },
    { speaker: 'Доктор', text: 'b' },
    { speaker: 'Отзыв 1 женщина(LATAM)', text: 'c' },
  ];
  automation.isRunning = true;

  await automation.processQueue();

  assert.deepEqual(completed, ['Диктор', 'Отзыв 1 женщина(LATAM)'], 'следующие реплики должны обработаться');
  assert.equal(automation.queue[1].status, 'error');
});

test('неоднозначная оплата по-прежнему останавливает очередь', async () => {
  const { __VoiceoverAutomation: Automation } = loadAutomation();
  const automation = new Automation();
  automation.sleep = async () => {};
  automation.processEntry = async (entry) => {
    entry.paidSubmissionStarted = true; // ответ потерян: возможно, уже списалось
    throw new Error('Direct generation may have been accepted: minimax_direct_response_timeout');
  };
  automation.queue = [{ speaker: 'Диктор', text: 'a' }, { speaker: 'Доктор', text: 'b' }];
  automation.isRunning = true;

  await assert.rejects(() => automation.processQueue(), /may have been accepted/);
  assert.equal(automation.queue[1].status, undefined, 'вторая реплика не должна отправляться');
});
