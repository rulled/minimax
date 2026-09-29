// Тесты прямого взаимодействия со стором MiniMax (ветка feat/direct-state):
// - Вставка текста через tts/setText (в обход Slate editor DOM)
// - Установка языка через tts/setLanguage (в обход Ant-Select)
// - Переключение режима Long Text через tts/updateIsAsync (в обход UI-тумблера)
// - Очередь и задержка старта для параллельного режима (2+ потока)
// - Джиттер при лимите частоты (2600018)
// Запуск: node --test tests/direct_state.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noop = () => {};

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
  const logs = [];
  const sandbox = {
    console: { log: (...args) => logs.push(String(args[0])), error: noop, warn: noop },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    crypto: { randomUUID: () => 'test-uuid' },
    window: { addEventListener: noop, removeEventListener: noop, location: { href: 'https://www.minimax.io/' } },
    document: {
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      evaluate: () => ({ singleNodeValue: null }),
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
  sandbox.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'content_script.js' });
  return { automation: new sandbox.__VoiceoverAutomation(), logs, sandbox };
}

test('insertText: текст ставится напрямую через стор, без DOM Slate редактора', async () => {
  const { automation, logs } = loadAutomation();
  const bridgeCalls = [];
  automation.callBridgeTimed = async (timeout, method, ...args) => {
    bridgeCalls.push({ method, args });
    if (method === 'setStoreText') {
      return { ok: true, length: args[0].length };
    }
    return { ok: false };
  };

  const dummyEl = {};
  await automation.insertText(dummyEl, 'Hello direct store text');

  assert.equal(bridgeCalls.length, 1, 'должен быть ровно один вызов к мосту');
  assert.equal(bridgeCalls[0].method, 'setStoreText');
  assert.equal(bridgeCalls[0].args[0], 'Hello direct store text');
  assert.ok(logs.some((l) => l.includes('Text set via MiniMax store')), 'успех должен логироваться');
});

test('insertText: откат на Slate fiber DOM при недоступности стора', async () => {
  const { automation, logs } = loadAutomation();
  const bridgeCalls = [];
  automation.sleep = async () => {};
  automation.callBridgeTimed = async (timeout, method, ...args) => {
    bridgeCalls.push(method);
    if (method === 'setStoreText') return { ok: false, reason: 'minimax_store_missing' };
    if (method === 'insertText') return { ok: true };
    if (method === 'getText') return 'Hello fallback text';
    return { ok: true };
  };

  const dummyEl = {};
  await automation.insertText(dummyEl, 'Hello fallback text');

  assert.ok(bridgeCalls.includes('setStoreText'), 'сначала пробует стор');
  assert.ok(bridgeCalls.includes('insertText'), 'затем откатывается на insertText');
  assert.ok(logs.some((l) => l.includes('fallback to Slate DOM')), 'откат виден в логах');
});

test('ensureLanguage: язык применяется экшеном стора без Ant-Select выпадашки', async () => {
  const { automation, logs } = loadAutomation();
  const bridgeCalls = [];
  automation.callBridgeTimed = async (timeout, method, ...args) => {
    bridgeCalls.push({ method, args });
    if (method === 'setStoreLanguage') {
      return { ok: true, language: args[0], isDetecting: false };
    }
    return { ok: false };
  };

  await automation.ensureLanguage('Russian');

  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].method, 'setStoreLanguage');
  assert.equal(bridgeCalls[0].args[0], 'Russian');
  assert.ok(logs.some((l) => l.includes('Language "Russian" set via MiniMax store')));
});

test('ensureLanguage: откат на UI при ошибке стора', async () => {
  const { automation, logs } = loadAutomation();
  automation.callBridgeTimed = async (timeout, method) => {
    if (method === 'setStoreLanguage') return { ok: false, reason: 'minimax_store_missing' };
    return { ok: false };
  };

  // UI-ветка упадёт на отсутствии селектора в заглушке DOM
  await assert.rejects(
    () => automation.ensureLanguage('Russian'),
    /Language selector not found/
  );
  assert.ok(logs.some((l) => l.includes('fallback to UI')));
});

test('setLongTextMode: режим переключается экшеном стора tts/updateIsAsync', async () => {
  const { automation, logs } = loadAutomation();
  const bridgeCalls = [];
  automation.callBridgeTimed = async (timeout, method, ...args) => {
    bridgeCalls.push({ method, args });
    if (method === 'setStoreLongTextMode') {
      return { ok: true, isAsync: Boolean(args[0]) };
    }
    return { ok: false };
  };

  const res = await automation.setLongTextMode(true);

  assert.equal(res, true);
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].method, 'setStoreLongTextMode');
  assert.equal(bridgeCalls[0].args[0], true);
  assert.ok(logs.some((l) => l.includes('Long Text mode enabled via MiniMax store')));
});

test('2+ потока: startDelayMs задаёт задержку старта воркера', async () => {
  const { automation } = loadAutomation();
  let sleptMs = 0;
  automation.sleep = async (ms) => { sleptMs += ms; };
  automation.processQueue = async () => {};
  automation.setLongTextMode = async () => false;

  automation.setStartDelay(750);
  await automation.start();

  assert.ok(sleptMs >= 750, `Воркер должен был подождать 750 мс, подождал ${sleptMs} мс`);
});

test('обход лимита 2600018: пауза использует рандомизированный джиттер', async () => {
  const { automation } = loadAutomation();
  const sleepDurations = [];
  automation.sleep = async (ms) => { sleepDurations.push(ms); };
  automation.notifyProgress = () => {};

  const entry = {
    speaker: 'Доктор',
    text: 'тест',
    rateLimited: true,
    submissionRejected: true,
    rateLimitAttempts: 0
  };

  // Симулируем попытку в блоке catch
  automation.isRunning = true;
  automation.queue = [entry];
  automation.currentIndex = 0;

  // Запуск одной итерации с ошибкой лимита
  let attempts = 0;
  automation.processEntry = async (e) => {
    attempts++;
    if (attempts === 1) {
      e.rateLimited = true;
      e.submissionRejected = true;
      throw new Error('Rate limit 2600018');
    }
  };

  await automation.processQueue();

  // Должен быть сон с базой 10000 + случайный джиттер (0..2500)
  const rateLimitSleep = sleepDurations.find((ms) => ms >= 10000 && ms <= 12500);
  assert.ok(rateLimitSleep != null, `Ожидалась пауза между 10000 и 12500 мс, получено: ${JSON.stringify(sleepDurations)}`);
});
